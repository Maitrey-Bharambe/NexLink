import { memo, useEffect, useMemo } from 'react';
import { ReactFlow, Controls, Handle, Position, useReactFlow, useStore, useNodesInitialized } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Server, Monitor } from 'lucide-react';
import { StatusDot, Badge } from './Primitives.jsx';

/**
 * Live hub-and-spoke topology (docs/DESIGN_DECISIONS.md D1).
 * The hub is the WireGuard gateway; each device is one tunnel to it.
 * Nodes and edges are derived from the server snapshot, never hard-coded.
 */

const EDGE_COLORS = {
  CONNECTED: 'var(--c-accent)',
  DEGRADED: 'var(--c-gold)',
  RECONNECTING: 'var(--c-gold)',
  DISCONNECTED: 'var(--c-taupe)',
  ANOMALY: 'var(--c-danger)',
};

const HubNode = memo(function HubNode({ data }) {
  const up = data.serverStatus === 'CONNECTED';
  return (
    <div className="relative w-[220px]">
      <div className={`relative rounded-xl border bg-surface px-4 py-3 shadow-[var(--s-card)] ${up ? 'border-accent/70' : 'border-line-strong'}`}>
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-on-accent">
            <Server size={17} />
          </div>
          <div className="min-w-0">
            <div className="text-[12px] font-bold tracking-[0.12em] text-ink">CONTROL HUB</div>
            <div className="mono text-[12px] text-accent-ink">{data.ip}</div>
          </div>
          <StatusDot status={data.serverStatus} pulse className="ml-auto" />
        </div>
        <div className="mt-2.5 flex items-center justify-between border-t border-line pt-2 text-[10.5px] text-muted">
          <span>Gateway</span>
          <span className="mono">{data.cidr}</span>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
});

const DeviceNode = memo(function DeviceNode({ data }) {
  const d = data.device;
  const border = data.selected ? 'border-accent ring-2 ring-accent/40' : d.anomaly ? 'border-danger' : d.status === 'DEGRADED' ? 'border-gold' : 'border-line';
  return (
    <div className={`w-[176px] cursor-pointer rounded-lg border bg-surface px-3 py-2.5 shadow-[var(--s-card)] transition-colors hover:border-accent/60 ${border}`}>
      <Handle type="target" position={Position.Top} />
      <div className="flex items-center gap-2">
        <Monitor size={14} className="text-muted" />
        <span className="truncate text-[12.5px] font-semibold">{d.label || d.hostname}</span>
        {d.simulated && <Badge tone="blue">SIM</Badge>}
        <StatusDot status={d.status} className="ml-auto" />
      </div>
      <div className="mono mt-1 text-[11.5px] text-accent-ink">{d.virtualIp || '—'}</div>
      <div className="mt-1 flex justify-between text-[10.5px] text-muted">
        <span className="truncate">{d.os || 'Unknown OS'}</span>
        <span className="tabular-nums">{d.latest?.latencyMs != null ? `${Math.round(d.latest.latencyMs)} ms` : ''}{d.latest?.packetLossPct ? ` · ${d.latest.packetLossPct}%` : ''}</span>
      </div>
    </div>
  );
});

const nodeTypes = { hub: HubNode, device: DeviceNode };

/** Re-fit when the panel is resized (fitView alone only runs on mount). */
function FitOnResize({ options, nodeCount }) {
  const { fitView } = useReactFlow();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const measured = useNodesInitialized();
  useEffect(() => {
    if (width && height && measured) fitView(options);
  }, [fitView, width, height, measured, nodeCount, options]);
  return null;
}

function layout(devices, network, serverStatus, selectedId) {
  const perRow = 6;
  const colW = 200;
  const rowH = 150;
  const rows = Math.ceil(devices.length / perRow) || 1;
  const widest = Math.min(devices.length, perRow) || 1;
  const hubX = ((widest - 1) * colW) / 2 + (176 - 220) / 2;

  const nodes = [{
    id: 'hub',
    type: 'hub',
    position: { x: hubX, y: 0 },
    data: { ip: network.gateway, cidr: network.cidr, serverStatus },
    draggable: false,
  }];
  const edges = [];

  devices.forEach((d, i) => {
    const row = Math.floor(i / perRow);
    const inRow = row === rows - 1 ? devices.length - row * perRow : perRow;
    const offset = ((widest - inRow) * colW) / 2;
    nodes.push({
      id: d.deviceId,
      type: 'device',
      position: { x: offset + (i % perRow) * colW, y: 160 + row * rowH },
      data: { device: d, selected: d.deviceId === selectedId },
    });
    const state = d.anomaly ? 'ANOMALY' : d.status;
    const live = d.status === 'CONNECTED';
    edges.push({
      id: `hub-${d.deviceId}`,
      source: 'hub',
      target: d.deviceId,
      type: 'smoothstep',
      className: live ? 'edge-live' : '',
      style: {
        stroke: EDGE_COLORS[state] || 'var(--c-line-strong)',
        strokeDasharray: state === 'DISCONNECTED' ? '3 5' : undefined,
      },
    });
  });
  return { nodes, edges };
}

export default function NetworkTopology({ devices, network, serverStatus, emptyHint, onSelect, selectedId }) {
  const { nodes, edges } = useMemo(() => layout(devices, network, serverStatus, selectedId), [devices, network, serverStatus, selectedId]);
  const fitOptions = useMemo(() => ({ padding: devices.length ? 0.3 : 1.2, maxZoom: 1.15 }), [devices.length]);

  return (
    <div className="theme-deep net-grid relative h-full w-full bg-brand">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={fitOptions}
        minZoom={0.3}
        maxZoom={1.8}
        nodesConnectable={false}
        zoomOnScroll={false}
        preventScrolling={false}
        elementsSelectable
        onNodeClick={(_, node) => onSelect?.(node.id === 'hub' ? null : node.id)}
        onPaneClick={() => onSelect?.(null)}
        proOptions={{ hideAttribution: true }}
        style={{ background: 'transparent' }}
      >
        <Controls showInteractive={false} position="bottom-right" />
        <FitOnResize options={fitOptions} nodeCount={nodes.length} />
      </ReactFlow>

      {devices.length === 0 && emptyHint && (
        <div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center px-6">
          <div className="pointer-events-auto max-w-lg rounded-xl border border-dashed border-line-strong bg-surface px-4 py-3 text-center text-[12px] leading-relaxed text-ink-2">
            {emptyHint}
          </div>
        </div>
      )}
    </div>
  );
}
