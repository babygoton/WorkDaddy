import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import hotToast, { Toaster, ToastBar } from 'react-hot-toast';
import { styleTarget } from './goober-scoped';

let host, reactRoot;
const textColor = 'var(--wb-color-text-primary,#1f1f1f)';
function mount() {
  if (host?.isConnected) return;
  destroy();
  host = document.createElement('div');
  host.id = 'wbs-toast-root';
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = ':host{font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--wb-color-text-primary,#1f1f1f)}*{box-sizing:border-box}.wbs-hot-message{white-space:pre-wrap;overflow-wrap:anywhere;min-width:0;max-height:min(35vh,200px);overflow:auto}.wbs-hot-close{width:22px;height:22px;flex:0 0 22px;border:0;border-radius:6px;background:transparent;color:var(--wb-color-text-secondary,#666);font:18px/1 sans-serif;cursor:pointer;margin-left:4px}.wbs-hot-close:hover{background:var(--wb-bg-hover,#eee)}.wbs-hot-close:focus-visible{outline:2px solid var(--wb-accent-blue,#4f86ff);outline-offset:1px}';
  shadow.append(style, styleTarget);
  const node = document.createElement('div');
  shadow.appendChild(node);
  // Toast interaction cannot reach WorkBuddy's composer or overlay handlers.
  for (const type of ['click', 'pointerdown', 'pointerup', 'keydown', 'keyup']) shadow.addEventListener(type, e => e.stopPropagation());
  document.body.appendChild(host);
  reactRoot = createRoot(node);
  flushSync(() => reactRoot.render(<Toaster position="bottom-center" gutter={8} containerStyle={{ bottom: 24, top: 16, left: 16, right: 16 }} toastOptions={{
    duration: 4200,
    removeDelay: 250,
    style: { fontSize: 12, lineHeight: 1.5, maxWidth: 'min(440px,calc(100vw - 32px))', padding: '9px 12px', borderRadius: 10, background: 'var(--wb-bg-popover,var(--wb-bg-secondary,#fff))', color: textColor, border: '1px solid var(--wb-border-default,#e6e6e6)', boxShadow: '0 6px 24px rgb(0 0 0 / 14%)' },
  }}>{t => <ToastBar toast={t}>{({ icon, message }) => <>{icon}<div className="wbs-hot-message">{message}</div><button className="wbs-hot-close" aria-label="Dismiss notification" title="关闭 / Close" onClick={() => hotToast.dismiss(t.id)}>×</button></>}</ToastBar>}</Toaster>));
}
function show(detail = {}) {
  mount();
  const level = ['info','success','warning','error','loading'].includes(detail.level) ? detail.level : 'info';
  const message = String(detail.message ?? '').slice(0, 2000);
  const options = { id: detail.id || undefined, position: 'bottom-center', duration: Number.isFinite(detail.duration) ? Math.min(60000, Math.max(1000, detail.duration)) : level === 'loading' ? Infinity : 4200,
    ariaProps: { role: level === 'error' ? 'alert' : 'status', 'aria-live': level === 'error' ? 'assertive' : 'polite' } };
  if (level === 'warning') options.icon = <span aria-hidden="true" style={{color:'var(--wb-accent-orange,#b96b00)',fontWeight:700,fontSize:16}}>!</span>;
  const handler = hotToast[level] || hotToast;
  return handler(message, options);
}
function dismiss(id) { hotToast.dismiss(id); }
function destroy() {
  hotToast.remove();
  if (reactRoot) { reactRoot.unmount(); reactRoot = null; }
  host?.remove(); host = null;
}
window.__wbsToastRuntime = { mount, show, dismiss, destroy, version: 'react-hot-toast@2.6.0' };
