/** 第 4 階段完整實作；此殼僅滿足路由與無權限隔離。 */
export function ModePage() {
  return (
    <main>
      <h1>模式切換</h1>
      <div data-testid="empty-state" className="card">
        <p>目前為監看模式。尚無模式切換選項（串接尚未開放）。</p>
      </div>
    </main>
  );
}
