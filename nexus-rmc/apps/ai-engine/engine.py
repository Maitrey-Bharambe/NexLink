"""NexLink AI engine (D7): per-device anomaly detection with Isolation Forest.

POST /score
    {deviceId, features: [...names], history: [[...], ...], recent: [[...], ...]}
→   {score, severity, contributing: [feature names], model}

Each device is judged against ITS OWN baseline (the history window). The
model is refit on every call — the window is small (≤ 1440 samples), so a fit
takes milliseconds, and nothing has to be persisted. Bound to 127.0.0.1 only.

Run:  python -m uvicorn engine:app --host 127.0.0.1 --port 8000
"""
from __future__ import annotations

import numpy as np
from fastapi import FastAPI
from pydantic import BaseModel, Field
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import RobustScaler

app = FastAPI(title="NexLink AI engine", version="1.0.0")


class ScoreRequest(BaseModel):
    deviceId: str
    features: list[str]
    history: list[list[float]] = Field(min_length=20)
    recent: list[list[float]] = Field(min_length=1)


@app.get("/health")
def health():
    return {"status": "ok", "model": "isolation-forest"}


@app.post("/score")
def score(req: ScoreRequest):
    hist = np.asarray(req.history, dtype=float)
    recent = np.asarray(req.recent, dtype=float)
    hist = np.nan_to_num(hist)
    recent = np.nan_to_num(recent)

    scaler = RobustScaler().fit(hist)
    h = scaler.transform(hist)
    r = scaler.transform(recent)

    model = IsolationForest(n_estimators=150, contamination="auto", random_state=42).fit(h)
    # score_samples: higher = more normal. Convert to 0..1 "anomaly score"
    # relative to the device's own history distribution.
    hist_scores = model.score_samples(h)
    recent_scores = model.score_samples(r)
    cur = float(np.median(recent_scores))
    lo, hi = float(np.percentile(hist_scores, 1)), float(np.percentile(hist_scores, 50))
    anomaly = float(np.clip((hi - cur) / max(hi - lo, 1e-6), 0, 3) / 3)

    # Which features moved the most (robust z of the recent median vs history)?
    z = np.abs(np.median(r, axis=0))
    order = np.argsort(-z)
    contributing = [req.features[i] for i in order if z[i] >= 3][:3]

    if anomaly >= 0.55:
        severity = "high"
    elif anomaly >= 0.35:
        severity = "medium"
    elif anomaly >= 0.2:
        severity = "low"
    else:
        severity = "normal"
    if severity != "normal" and not contributing:
        contributing = [req.features[order[0]]]
    return {"score": round(anomaly, 3), "severity": severity, "contributing": contributing, "model": "isolation-forest", "samples": len(hist)}
