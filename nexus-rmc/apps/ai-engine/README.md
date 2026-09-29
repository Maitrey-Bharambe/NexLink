# NexLink AI engine

FastAPI + scikit-learn. Scores each device against **its own** history with an Isolation Forest
(robust-scaled features: CPU, RAM, rx, tx, latency, loss, connections). It is bound to
`127.0.0.1` only.

```bash
pip install -r requirements.txt
```

```bash
python -m uvicorn engine:app --host 127.0.0.1 --port 8000
```

The endpoint is `POST /score {deviceId, features, history, recent}`. It returns
`{score 0..1, severity, contributing, model}`.

The control server calls the engine every 60 s for each online device. If the engine is not
running, the server uses a robust z-score detector and labels it `robust-zscore (fallback)`.
