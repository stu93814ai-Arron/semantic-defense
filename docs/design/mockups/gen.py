import os
T={
'a':dict(name='深色值勤控制台',bg='#0B1220',sf='#131C2E',sf2='#1B2740',bd='#2A3854',tx='#E6EDF7',mu='#93A3BD',pr='#3B82F6',dan='#F87171',war='#FBBF24',ok='#34D399',inf='#60A5FA',r='10px',f='15px',pad='16px'),
'b':dict(name='淺色清爽企業',bg='#F5F7FA',sf='#FFFFFF',sf2='#EEF2F7',bd='#D8DEE8',tx='#1F2937',mu='#5B6575',pr='#2563EB',dan='#B91C1C',war='#B45309',ok='#047857',inf='#1D4ED8',r='12px',f='15px',pad='20px'),
'c':dict(name='高對比緊湊',bg='#000000',sf='#0A0A0A',sf2='#1A1A1A',bd='#FFFFFF',tx='#FFFFFF',mu='#D4D4D4',pr='#FFD400',dan='#FF5C5C',war='#FFD400',ok='#3DFF8F',inf='#5CC8FF',r='2px',f='14px',pad='10px'),
}
def css(t): return f""":root{{--color-bg:{t['bg']};--color-surface:{t['sf']};--color-surface-2:{t['sf2']};--color-border:{t['bd']};--color-text:{t['tx']};--color-text-muted:{t['mu']};--color-primary:{t['pr']};--color-danger:{t['dan']};--color-warning:{t['war']};--color-success:{t['ok']};--color-info:{t['inf']};--radius-md:{t['r']};--space-card:{t['pad']}}}
*{{box-sizing:border-box}}body{{margin:0;width:1440px;height:900px;background:var(--color-bg);color:var(--color-text);font:{t['f']}/1.6 "Noto Sans TC","Noto Sans CJK TC",sans-serif;overflow:hidden}}
.top{{height:56px;display:flex;align-items:center;gap:24px;padding:0 24px;background:var(--color-surface);border-bottom:1px solid var(--color-border)}}
.logo{{font-weight:700;font-size:18px}}.nav a{{margin-right:20px;color:var(--color-text-muted)}}.nav a.on{{color:var(--color-primary);font-weight:700}}
.wrap{{padding:24px 32px}}h1{{font-size:24px;margin:0 0 16px}}
.card{{background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-md);padding:var(--space-card)}}
.btn{{display:inline-block;padding:10px 20px;border-radius:var(--radius-md);font-weight:700;border:2px solid transparent}}
.p{{background:var(--color-primary);color:{'#000' if t is T['c'] else '#fff'}}}.d{{border-color:var(--color-danger);color:var(--color-danger)}}.g{{opacity:.45}}
.tag{{display:inline-block;padding:2px 10px;border-radius:999px;font-size:13px;font-weight:700;border:1px solid currentColor}}
.td{{color:var(--color-danger)}}.tw{{color:var(--color-warning)}}.ts{{color:var(--color-success)}}.ti{{color:var(--color-info)}}.tm{{color:var(--color-text-muted)}}
table{{width:100%;border-collapse:collapse}}th,td{{text-align:left;padding:{t['pad']} 12px;border-bottom:1px solid var(--color-border)}}th{{color:var(--color-text-muted);font-weight:500;font-size:13px}}
.banner{{padding:12px 16px;border-radius:var(--radius-md);border-left:6px solid;margin-bottom:16px;background:var(--color-surface-2)}}
.mono{{font-family:"Noto Sans Mono CJK TC",monospace}}"""
def top(on): return f'<div class="top"><span class="logo">🛡 應用語意防禦</span><span class="nav">'+''.join(f'<a class="{"on" if x==on else ""}">{x}</a>' for x in ['待判斷','判斷紀錄','生效限制','緊急暫停'])+'</span><span style="margin-left:auto" class="tm">值勤：王小明 · 剩餘工作階段 42 分</span></div>'
def page(t,body): return f'<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><style>{css(t)}</style></head><body>{body}</body></html>'
login='''<div style="display:flex;height:900px;align-items:center;justify-content:center"><div class="card" style="width:420px;padding:40px">
<div class="logo" style="font-size:24px">🛡 應用語意防禦</div><p class="tm">值勤後台登入</p>
<div class="banner ti" style="border-color:var(--color-info)">工作階段已逾時，請重新登入。</div>
<label>帳號</label><div class="card" style="padding:10px;margin:6px 0 14px">wang.xm@corp</div>
<label>密碼</label><div class="card" style="padding:10px;margin:6px 0 20px;outline:3px solid var(--color-primary);outline-offset:2px">••••••••••</div>
<div class="btn p" style="width:100%;text-align:center">登入</div><p class="tm" style="font-size:13px">登入即同意所有操作留存稽核紀錄。</p></div></div>'''
rows=[('C-1042','訂單系統','查詢自己的訂單 → 匯出全部會員資料','高','td','AI 建議已就緒','ts','00:03'),
('C-1041','客服後台','一般查詢 → 大量讀取工單','中','tw','AI 撰寫中 5 秒','ti','00:05'),
('C-1040','金流 API','登入 → 修改他人收款帳號','高','td','超過七秒未出結果','tw','00:09'),
('C-1039','人資系統','查詢自己 → 讀取薪資表','中','tw','另一位值勤正在核准','tw','01:12'),
('C-1038','訂單系統','重複匯出報表','低','ti','限制已到期','tm','23:40')]
lst=top('待判斷')+'<div class="wrap"><h1>待判斷 <span class="tag ti">5 件</span></h1><div class="banner tw" style="border-color:var(--color-warning)">⚠ 入口「金流 API」連線中斷 2 分鐘，事件可能延遲。</div><div class="card" style="padding:0 8px"><table><tr><th>案件</th><th>應用</th><th>偏移摘要</th><th>風險</th><th>狀態</th><th>成案</th></tr>'+''.join(f'<tr><td class="mono">{a}</td><td>{b}</td><td>{c}</td><td><span class="tag {e}">{d}</span></td><td><span class="tag {g}">{f}</span></td><td class="mono tm">{h}</td></tr>' for a,b,c,d,e,f,g,h in rows)+'</table></div><p class="tm">空狀態：「目前沒有待判斷案件，入口運作正常。」</p></div>'
def judge(variant):
  ban={'countdown':'','timeout':'<div class="banner tw" style="border-color:var(--color-warning)">⏱ 已超過七秒仍無 AI 建議。可改為手動退回，或等待重試結果。</div>',
  'conflict':'<div class="banner td" style="border-color:var(--color-danger)">⛔ 李大華 已於 22:14:05 先核准此判斷，你的核准未寫入。以下為已生效版本。</div>',
  'expired':'<div class="banner" style="border-color:var(--color-text-muted)">此限制已於 22:40 到期（或已被撤回），僅供檢視，無法再核准。</div>'}[variant]
  cd={'countdown':('3','AI 建議剩 4 秒','ti',30),'timeout':('0','逾時','tw',100),'conflict':('—','已由他人核准','td',100),'expired':('—','已到期','tm',100)}[variant]
  dis='' if variant=='countdown' else ' g'
  return top('待判斷')+f'''<div class="wrap"><p class="tm">待判斷 › C-1042</p>{ban}<div style="display:flex;gap:24px">
<div class="card" style="flex:1"><h1>C-1042 · 訂單系統 <span class="tag td">高風險</span></h1>
<p class="tm">偏移路徑</p><p class="mono">/orders/{{id}} (read) → /admin/members/export (admin)</p>
<p class="tm">AI 建議的限制</p><div class="card" style="background:var(--color-surface-2)"><b>禁止此工作階段呼叫 /admin/members/export，為期 30 分鐘</b><br><span class="tm">變形測試：5 種說法皆落在同一條限制 ✓</span></div>
<div style="margin-top:24px;display:flex;gap:12px"><span class="btn p{dis}">核准並簽名</span><span class="btn d{dis}">退回</span></div></div>
<div class="card" style="width:340px;text-align:center"><p class="tm">距成案</p><div class="mono" style="font-size:64px;font-weight:700" >00:0{cd[0] if cd[0]!='—' else '7'}</div>
<div style="height:10px;background:var(--color-surface-2);border-radius:99px"><div style="height:10px;width:{cd[3]}%;background:var(--color-{ 'info' if variant=='countdown' else 'warning'});border-radius:99px"></div></div>
<p><span class="tag {cd[2]}">{cd[1]}</span></p><p class="tm" style="font-size:13px">七秒內應出現可核准判斷</p></div></div></div>'''
for k,t in T.items():
  pages={'login':login,'judgments':lst,'judgment':judge('countdown'),'judgment-timeout':judge('timeout'),'judgment-conflict':judge('conflict'),'judgment-expired':judge('expired')}
  for n,b in pages.items(): open(f'mockups/direction-{k}-{n}.html','w').write(page(t,b))
