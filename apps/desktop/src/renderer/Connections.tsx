import { useEffect, useState } from 'react';
export function Connections({ onToolsChanged }: { onToolsChanged: () => void }) {
  const [state, setState] = useState<{
    vaultAvailable: boolean;
    providers: Record<string, boolean>;
    identity: { configured: boolean; signedIn: boolean; subject?: string };
  }>();
  const [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [servers, setServers] = useState<string[]>([]);
  const refresh = async () => {
    const result = await window.sand.studio.security();
    if (result.ok) setState(result.value);
    else setMessage(result.error.message);
  };
  useEffect(() => {
    void refresh();
  }, []);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      await refresh();
      onToolsChanged();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Không kết nối được.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="studio-section">
      <summary>Kết nối & bảo mật</summary>
      <p className="studio-caption">
        OS credential store: {state?.vaultAvailable ? 'khả dụng' : 'chưa khả dụng'}. Chỉ main
        process đọc credential; không nhập key vào workflow.
      </p>
      {Object.entries(state?.providers ?? {}).map(([name, configured]) => (
        <div key={name}>
          <small>
            {name}: {configured ? 'đã cấu hình' : 'unavailable'}
          </small>
          <div className="studio-actions">
            <button
              className="secondary"
              disabled={busy || !configured || !state?.vaultAvailable}
              onClick={() =>
                void act(async () => {
                  const result = await window.sand.studio.storeEnvironmentKey(name);
                  if (!result.ok) throw new Error(result.error.message);
                  setMessage('Đã mã hóa credential từ môi trường bằng OS secret storage.');
                })
              }
            >
              Lưu từ môi trường
            </button>
            <button
              className="secondary"
              disabled={busy || !state?.vaultAvailable}
              onClick={() =>
                void act(async () => {
                  const result = await window.sand.studio.removeStoredKey(name);
                  if (!result.ok) throw new Error(result.error.message);
                  setMessage(
                    result.value.environmentStillConfigured
                      ? 'Đã xóa bản lưu; biến môi trường vẫn đang cấu hình provider.'
                      : 'Đã xóa credential đã lưu.',
                  );
                })
              }
            >
              Xóa bản lưu
            </button>
          </div>
        </div>
      ))}
      <p className="studio-caption">
        OIDC:{' '}
        {state?.identity.signedIn
          ? 'đã đăng nhập'
          : state?.identity.configured
            ? 'sẵn sàng đăng nhập'
            : 'unavailable — cần issuer và public client ID'}
        . Đăng nhập này chưa cấp quyền backend tenant.
      </p>
      <button
        className="secondary"
        disabled={busy || !state?.identity.configured || !state?.vaultAvailable}
        onClick={() =>
          void act(async () => {
            const result = await window.sand.studio.login();
            if (!result.ok) throw new Error(result.error.message);
            setMessage('Đăng nhập đã được xác minh.');
          })
        }
      >
        Đăng nhập bằng trình duyệt
      </button>
      <button
        className="secondary"
        disabled={busy || !state?.identity.signedIn}
        onClick={() =>
          void act(async () => {
            const result = await window.sand.studio.logout();
            if (!result.ok) throw new Error(result.error.message);
            setMessage(
              result.value.revoked
                ? 'Đã thu hồi phiên ở provider.'
                : 'Đã xóa phiên local; chưa xác nhận revocation ở provider.',
            );
          })
        }
      >
        Đăng xuất
      </button>
      <h3>Khôi phục workflow</h3>
      <button
        className="secondary"
        disabled={busy}
        onClick={() =>
          void act(async () => {
            const result = await window.sand.studio.backup();
            if (!result.ok) throw new Error(result.error.message);
            if (result.value) setMessage('Đã tạo backup workflow: ' + result.value);
          })
        }
      >
        Backup workflow & approvals
      </button>
      <p className="studio-caption">
        Chỉ khi không còn request chạy. Backup không gồm credential hay file repository.
      </p>
      <h3>MCP servers</h3>
      <p className="studio-caption">
        Chọn JSON server tin cậy. Local stdio chạy với quyền OS của bạn. Remote cần HTTPS public;
        remote OAuth chưa được bật.
      </p>
      <button
        className="secondary"
        disabled={busy}
        onClick={() =>
          void act(async () => {
            const result = await window.sand.studio.connectMcp();
            if (!result.ok) throw new Error(result.error.message);
            if (result.value) {
              setServers((s) => [...s, result.value!.id]);
              setMessage(
                'Đã tải manifest ' +
                  result.value.manifestHash.slice(0, 12) +
                  '; ' +
                  result.value.tools.length +
                  ' tools.',
              );
            }
          })
        }
      >
        Kết nối MCP từ file
      </button>
      {servers.map((id) => (
        <button
          className="secondary"
          key={id}
          disabled={busy}
          onClick={() =>
            void act(async () => {
              const result = await window.sand.studio.disconnectMcp(id);
              if (!result.ok) throw new Error(result.error.message);
              setServers((s) => s.filter((x) => x !== id));
            })
          }
        >
          Ngắt {id}
        </button>
      ))}
      {message && (
        <p role="status" className="studio-caption">
          {message}
        </p>
      )}
    </details>
  );
}
