T={
'd':dict(bg='#F4EFE6',sf='#FBF8F2',sf2='#ECE4D6',bd='#D9CDB8',tx='#2E2A24',mu='#5F574B',pr='#4F6B57',pron='#FFFFFF',dan='#9E3B2C',war='#8A5A12',ok='#3F6B4A',inf='#3E5F78',neu='#6B6358',r='18px',
  tex="background-image:radial-gradient(rgba(120,95,60,.05) 1px,transparent 1px),repeating-linear-gradient(90deg,rgba(150,110,60,.025) 0 2px,transparent 2px 7px);background-size:5px 5px,auto",
  side="linear-gradient(180deg,#D2B288,#C6A072)",serif='"Cormorant Garamond","Noto Serif CJK TC","Noto Serif TC",serif',hd='600'),
'e':dict(bg='#FAF8F5',sf='#FFFFFF',sf2='#F1EDE8',bd='#E2DCD4',tx='#1E1C1A',mu='#5E5751',pr='#A4472C',pron='#FFFFFF',dan='#A3262A',war='#87570F',ok='#3B6B52',inf='#3B5675',neu='#6A635D',r='0px',
  tex="background-image:linear-gradient(115deg,transparent 40%,rgba(160,150,140,.07) 45%,transparent 52%),linear-gradient(28deg,transparent 60%,rgba(150,140,130,.06) 63%,transparent 68%)",
  side="#1E1C1A",serif='"Playfair Display","Noto Serif CJK TC","Noto Serif TC",serif',hd='500'),
}
def css(k,t): return f""":root{{--color-bg:{t['bg']};--color-surface:{t['sf']};--color-surface-2:{t['sf2']};--color-border:{t['bd']};--color-text:{t['tx']};--color-text-muted:{t['mu']};--color-primary:{t['pr']};--color-danger:{t['dan']};--color-warning:{t['war']};--color-success:{t['ok']};--color-info:{t['inf']};--color-neutral:{t['neu']};--radius-md:{t['r']};--font-serif:{t['serif']}}}
*{{box-sizing:border-box}}body{{margin:0;width:1440px;height:900px;background-color:var(--color-bg);{t['tex']};color:var(--color-text);font:15px/1.75 "Noto Sans CJK TC","Noto Sans TC",sans-serif;overflow:hidden;letter-spacing:.02em}}
.serif{{font-family:var(--font-serif);font-weight:{t['hd']}}}h1{{font-family:var(--font-serif);font-weight:{t['hd']};font-size:40px;margin:0 0 8px;letter-spacing:.04em}}
.eyebrow{{font-size:12px;letter-spacing:.3em;text-transform:uppercase;color:var(--color-text-muted)}}
.card{{background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-md);padding:32px}}
.btn{{display:inline-block;padding:14px 32px;border-radius:{'999px' if k=='d' else '0'};font-weight:500;letter-spacing:.1em;border:1px solid var(--color-text)}}
.p{{background:var(--color-primary);border-color:var(--color-primary);color:{t['pron']}}}.o{{color:var(--color-danger);border-color:var(--color-danger);background:transparent}}.g{{background:var(--color-surface-2);color:var(--color-neutral);border-color:var(--color-border)}}
.tag{{display:inline-block;padding:2px 14px;border-radius:{'999px' if k=='d' else '0'};font-size:13px;font-weight:500}}
.td{{color:var(--color-danger);background:color-mix(in srgb,var(--color-danger) 10%,var(--color-surface))}}.tw{{color:var(--color-warning);background:color-mix(in srgb,var(--color-warning) 12%,var(--color-surface))}}.ts{{color:var(--color-success);background:color-mix(in srgb,var(--color-success) 12%,var(--color-surface))}}.ti{{color:var(--color-info);background:color-mix(in srgb,var(--color-info) 10%,var(--color-surface))}}.tm{{color:var(--color-neutral);background:var(--color-surface-2)}}
.mu{{color:var(--color-text-muted)}}
table{{width:100%;border-collapse:collapse}}th,td{{text-align:left;padding:20px 16px;border-bottom:1px solid var(--color-border)}}th{{font-weight:400;font-size:12px;letter-spacing:.2em;color:var(--color-text-muted)}}
.banner{{padding:18px 24px;border-radius:var(--radius-md);margin-bottom:28px;display:flex;gap:14px;align-items:center;border:1px solid}}
.bd{{color:var(--color-danger);border-color:var(--color-danger);background:color-mix(in srgb,var(--color-danger) 7%,var(--color-surface))}}.bw{{color:var(--color-warning);border-color:var(--color-warning);background:color-mix(in srgb,var(--color-warning) 8%,var(--color-surface))}}.bn{{color:var(--color-text);border-color:var(--color-neutral);background:var(--color-surface-2)}}
.banner b{{font-family:var(--font-serif);font-size:18px}}"""
def shell(k,t,body):
  nav=['待判斷','判斷紀錄','生效限制','緊急暫停']
  if k=='d':
    s=f'''<div style="display:flex;height:900px"><aside style="width:240px;background:{t['side']};color:#2E2A24;padding:40px 28px"><div class="serif" style="font-size:26px;line-height:1.3">應用<br>語意防禦</div><div class="eyebrow" style="color:#33291F;margin:6px 0 48px">Semantic Defense</div>'''+''.join(f'<div style="padding:10px 16px;margin-bottom:6px;border-radius:999px;{"background:#FBF8F2;font-weight:700" if i==0 else ""}">{n}</div>' for i,n in enumerate(nav))+f'''<div style="position:absolute;bottom:36px;font-size:13px">王小明 · 值勤中</div></aside><main style="flex:1;padding:56px 72px">{body}</main></div>'''
  else:
    s=f'''<header style="height:84px;display:flex;align-items:center;padding:0 96px;border-bottom:1px solid var(--color-border);background:var(--color-surface)"><span class="serif" style="font-size:24px;letter-spacing:.12em">SEMANTICA <span style="font-size:16px" class="mu">應用語意防禦</span></span><nav style="margin-left:auto;display:flex;gap:40px">'''+''.join(f'<span style="{"border-bottom:2px solid var(--color-primary);color:var(--color-primary)" if i==0 else "color:var(--color-text-muted)"};padding-bottom:4px">{n}</span>' for i,n in enumerate(nav))+f'''<span class="mu">王小明</span></nav></header><main style="padding:56px 96px">{body}</main>'''
  return f'<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><style>{css(k,t)}</style></head><body>{s}</body></html>'
def login(k,t):
  if k=='d':
    b=f'''<div style="display:flex;height:900px"><div style="flex:1;background:{t['side']};position:relative"><div style="position:absolute;inset:0;background:repeating-linear-gradient(92deg,rgba(90,60,30,.08) 0 3px,transparent 3px 19px)"></div><div style="position:absolute;left:80px;bottom:90px;color:#2E2A24"><div class="serif" style="font-size:56px;line-height:1.2">安靜地<br>守護每一次請求</div><div class="eyebrow" style="color:#33291F;margin-top:16px">Semantic Defense · Est. 2026</div></div></div>
<div style="width:620px;display:flex;align-items:center;justify-content:center"><div style="width:400px"><div class="eyebrow">Welcome back</div><h1>值勤登入</h1><p class="mu">請以公司帳號登入。所有操作將留存稽核紀錄。</p>
<div class="banner bn" style="margin:24px 0">工作階段已逾時，請重新登入。</div>
<div class="mu" style="font-size:13px">帳號</div><div class="card" style="padding:14px 20px;margin:6px 0 18px;border-radius:14px">wang.xm@corp</div>
<div class="mu" style="font-size:13px">密碼</div><div class="card" style="padding:14px 20px;margin:6px 0 28px;border-radius:14px;outline:2px solid var(--color-primary);outline-offset:3px">••••••••••</div>
<div class="btn p" style="width:100%;text-align:center">登入</div></div></div></div>'''
  else:
    b=f'''<div style="height:900px;display:flex;align-items:center;justify-content:center"><div style="width:520px;text-align:center"><div class="serif" style="font-size:44px;letter-spacing:.2em">SEMANTICA</div><div class="eyebrow" style="margin:4px 0 8px">應用語意防禦 · Console</div><div style="width:48px;height:1px;background:var(--color-primary);margin:28px auto"></div>
<div class="banner bn" style="justify-content:center">工作階段已逾時，請重新登入。</div>
<div style="text-align:left"><div class="eyebrow">帳號</div><div style="border-bottom:1px solid var(--color-text);padding:12px 0;margin-bottom:28px">wang.xm@corp</div>
<div class="eyebrow">密碼</div><div style="border-bottom:2px solid var(--color-primary);padding:12px 0;margin-bottom:44px;outline:2px solid var(--color-primary);outline-offset:6px">••••••••••</div></div>
<div class="btn p" style="width:100%">登 入</div><p class="mu" style="font-size:13px;margin-top:24px">所有操作將留存稽核紀錄</p></div></div>'''
  return f'<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><style>{css(k,t)}</style></head><body>{b}</body></html>'
rows=[('C-1042','訂單系統','查詢自己的訂單 → 匯出全部會員資料','高風險','td','AI 建議已就緒','ts','3 秒前'),
('C-1041','客服後台','一般查詢 → 大量讀取工單','中風險','tw','AI 撰寫中','ti','5 秒前'),
('C-1040','金流 API','登入 → 修改他人收款帳號','高風險','td','逾時：超過七秒','tw','9 秒前'),
('C-1039','人資系統','查詢自己 → 讀取薪資表','中風險','tw','他人核准中','tw','1 分前'),
('C-1038','訂單系統','重複匯出報表','低風險','ti','限制已到期','tm','23 分前')]
def judgments(k,t):
  b=f'<div class="eyebrow">Pending · 5 件</div><h1>待判斷</h1><p class="mu" style="margin:0 0 32px">依成案時間排列，七秒內應出現 AI 建議。</p><div class="banner bw"><b>入口連線中斷</b><span>「金流 API」已中斷 2 分鐘，事件可能延遲。</span></div><div class="card" style="padding:8px 24px"><table><tr><th>案件</th><th>應用</th><th>偏移摘要</th><th>風險</th><th>狀態</th><th>成案</th></tr>'+''.join(f'<tr><td class="serif" style="font-size:17px">{a}</td><td>{b_}</td><td>{c}</td><td><span class="tag {e}">{d}</span></td><td><span class="tag {g}">{f}</span></td><td class="mu">{h}</td></tr>' for a,b_,c,d,e,f,g,h in rows)+'</table></div>'
  return shell(k,t,b)
def judge(k,t,v):
  ban={'n':'','timeout':'<div class="banner bw"><b>已超過七秒</b><span>仍未取得 AI 建議。可手動退回，或等待重試結果。</span></div>',
  'conflict':'<div class="banner bd"><b>已由他人核准</b><span>李大華 於 22:14:05 先完成核准，你的核准未寫入。以下為已生效版本。</span></div>',
  'expired':'<div class="banner bn"><b>限制已到期</b><span>此限制已於 22:40 到期（或已被撤回），僅供檢視。</span></div>'}[v]
  sec,lab,tg,pct,col={'n':('3','AI 建議 · 剩 4 秒','ti',43,'var(--color-info)'),'timeout':('9','逾時','tw',100,'var(--color-warning)'),'conflict':('—','已由他人核准','td',100,'var(--color-danger)'),'expired':('—','已到期','tm',100,'var(--color-neutral)')}[v]
  btn='<span class="btn p">核准並簽名</span><span class="btn o">退回</span>' if v=='n' else ('<span class="btn g">核准並簽名</span><span class="btn o">手動退回</span>' if v=='timeout' else '<span class="btn g">核准並簽名</span><span class="btn g">退回</span>')
  sugg='<span class="mu">AI 尚未給出建議…</span>' if v=='timeout' else '<div class="serif" style="font-size:22px;line-height:1.5">禁止此工作階段呼叫<br>/admin/members/export，為期 30 分鐘</div><p class="mu" style="margin:12px 0 0">變形測試：五種說法皆落在同一條限制 ✓</p>'
  big=f'<div class="serif" style="font-size:96px;line-height:1">{sec}<span style="font-size:28px"> 秒</span></div>' if sec!='—' else '<div class="serif" style="font-size:64px;line-height:1.3">—</div>'
  ring='' 
  b=f'''<div class="eyebrow">待判斷 / C-1042</div>{ban if ban else '<div style="height:8px"></div>'}<div style="display:flex;gap:40px">
<div style="flex:1"><h1>C-1042 · 訂單系統</h1><span class="tag td">高風險</span><div style="margin:32px 0 10px" class="eyebrow">偏移路徑</div><p>/orders/{{id}}（讀取） → /admin/members/export（管理）</p>
<div class="eyebrow" style="margin:28px 0 10px">AI 建議的限制</div><div class="card" style="background:var(--color-surface-2)">{sugg}</div><div style="margin-top:36px;display:flex;gap:16px">{btn}</div></div>
<div class="card" style="width:340px;text-align:center;align-self:flex-start;padding:44px 32px"><div class="eyebrow">距成案</div><div style="margin:20px 0">{big}</div><div style="height:4px;background:var(--color-surface-2);border-radius:9px"><div style="height:4px;width:{pct}%;background:{col};border-radius:9px"></div></div><p style="margin-top:24px"><span class="tag {tg}">{lab}</span></p><p class="mu" style="font-size:13px">七秒內應出現可核准判斷</p></div></div>'''
  return shell(k,t,b)
for k,t in T.items():
  P={'login':login(k,t),'judgments':judgments(k,t),'judgment':judge(k,t,'n'),'judgment-timeout':judge(k,t,'timeout'),'judgment-conflict':judge(k,t,'conflict'),'judgment-expired':judge(k,t,'expired')}
  for n,h in P.items(): open(f'mockups/direction-{k}-{n}.html','w').write(h)
# contrast
def L(h):
  h=h.lstrip('#');c=[int(h[i:i+2],16)/255 for i in (0,2,4)];c=[x/12.92 if x<=.03928 else ((x+.055)/1.055)**2.4 for x in c];return .2126*c[0]+.7152*c[1]+.0722*c[2]
def cr(a,b):
  x,y=sorted([L(a),L(b)]);return (y+.05)/(x+.05)
out=[]
for k,t in T.items():
  for fg in ['tx','mu','pr','dan','war','ok','inf','neu']:
    for bg in ['bg','sf','sf2']:
      out.append(f"| {k.upper()} | {fg} {t[fg]} | {bg} {t[bg]} | {cr(t[fg],t[bg]):.2f} | {'✓' if cr(t[fg],t[bg])>=4.5 else '✗'} |")
  out.append(f"| {k.upper()} | 按鈕字 {t['pron']} | primary {t['pr']} | {cr(t['pron'],t['pr']):.2f} | {'✓' if cr(t['pron'],t['pr'])>=4.5 else '✗'} |")
open('mockups/contrast.md','w').write('\n'.join(out))
