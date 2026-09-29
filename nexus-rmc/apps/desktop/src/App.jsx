import { useEffect } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './stores/auth.js';
import AppShell from './layouts/AppShell.jsx';
import Login from './pages/Login.jsx';
import Overview from './pages/Overview.jsx';
import UserHome from './pages/UserHome.jsx';
import Devices from './pages/Devices.jsx';
import DeviceDetail from './pages/DeviceDetail.jsx';
import NetworkMap from './pages/NetworkMap.jsx';
import Connections from './pages/Connections.jsx';
import Vpn from './pages/Vpn.jsx';
import RemoteDesktop from './pages/RemoteDesktop.jsx';
import FileManager from './pages/FileManager.jsx';
import Terminal from './pages/Terminal.jsx';
import Sessions from './pages/Sessions.jsx';
import SystemMonitor from './pages/SystemMonitor.jsx';
import NetworkAnalysis from './pages/NetworkAnalysis.jsx';
import Traffic from './pages/Traffic.jsx';
import Alerts from './pages/Alerts.jsx';
import Assistant from './pages/Assistant.jsx';
import Diagnostics from './pages/Diagnostics.jsx';
import Reports from './pages/Reports.jsx';
import Users from './pages/Users.jsx';
import AuditLogs from './pages/AuditLogs.jsx';
import Settings from './pages/Settings.jsx';
import { Spinner } from './components/Primitives.jsx';

function AdminOnly({ children }) {
  const role = useAuth((s) => s.user?.role);
  return role === 'admin' ? children : <Navigate to="/" replace />;
}

export default function App() {
  const phase = useAuth((s) => s.phase);
  const boot = useAuth((s) => s.boot);
  const role = useAuth((s) => s.user?.role);

  useEffect(() => { boot(); }, [boot]);

  if (phase === 'signing_out') {
    return <div className="flex h-full items-center justify-center gap-3 bg-canvas text-muted"><Spinner /> Signing out…</div>;
  }
  if (phase !== 'authenticated') return <Login />;

  const admin = (el) => <AdminOnly>{el}</AdminOnly>;

  // HashRouter: works for both the Vite dev server and file:// in the packaged app.
  return (
    <HashRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={role === 'admin' ? <Overview /> : <UserHome />} />
          <Route path="devices" element={admin(<Devices />)} />
          <Route path="devices/:id" element={<DeviceDetail />} />
          <Route path="network-map" element={admin(<NetworkMap />)} />
          <Route path="connections" element={admin(<Connections />)} />
          <Route path="vpn" element={admin(<Vpn />)} />
          <Route path="remote-desktop" element={<RemoteDesktop />} />
          <Route path="files" element={<FileManager />} />
          <Route path="terminal" element={<Terminal />} />
          <Route path="sessions" element={<Sessions />} />
          <Route path="system" element={admin(<SystemMonitor />)} />
          <Route path="analysis" element={admin(<NetworkAnalysis />)} />
          <Route path="traffic" element={admin(<Traffic />)} />
          <Route path="alerts" element={<Alerts />} />
          <Route path="ai" element={<Assistant />} />
          <Route path="diagnostics" element={<Diagnostics />} />
          <Route path="reports" element={admin(<Reports />)} />
          <Route path="users" element={admin(<Users />)} />
          <Route path="audit" element={admin(<AuditLogs />)} />
          <Route path="settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
