# /apps/new 狀態稿（nordic=D、italian=E），沿用 gen_de.py 的 tokens 與 css
import os
src=open(os.path.join(os.path.dirname(__file__),'gen_de.py')).read()
exec(src.split('def shell')[0])
EXTRA=""".bi{color:var(--color-info);border-color:var(--color-info);background:color-mix(in srgb,var(--color-info) 7%,var(--color-surface))}
.bs{color:var(--color-success);border-color:var(--color-success);background:color-mix(in srgb,var(--color-success) 8%,var(--color-surface))}
.field{margin-bottom:16px}.field .lab{font-size:13px;color:var(--color-text-muted);margin-bottom:6px}.field .in{background:var(--color-surface);border:1px solid var(--color-border);border-radius:RAD;padding:12px 16px}
.steps{display:flex;gap:12px;margin:22px 0 24px}.step{flex:1;padding:10px 0;border-top:3px solid var(--color-border);color:var(--color-text-muted);font-size:13px}.step.on{border-color:var(--color-primary);color:var(--color-text);font-weight:700}.step.done{border-color:var(--color-success);color:var(--color-success)}
.observe{display:inline-flex;align-items:center;gap:8px;padding:4px 14px;border:1px solid var(--color-info);color:var(--color-info);background:color-mix(in srgb,var(--color-info) 10%,var(--color-surface));border-radius:RADC;font-size:13px;font-weight:700}
.sk{background:var(--color-surface-2);border-radius:6px;height:14px;margin:10px 0}
.stat{font-variant-numeric:lining-nums tabular-nums;font-family:var(--font-serif);font-size:56px;line-height:1.1}
.ts{font-size:13px}
.sw{background:var(--color-surface-2);display:inline-flex;border:1px solid var(--color-border);border-radius:RADC;padding:2px;font-size:13px}.sw span{padding:4px 12px;border-radius:RADC;color:var(--color-text-muted)}.sw .sel{background:var(--color-surface);color:var(--color-text);font-weight:700;box-shadow:inset 0 -2px 0 var(--color-primary)}"""
NAV=['應用接入','應用地圖']
COMPACT_E='''main{padding-top:26px!important}h1{font-size:34px}.steps{margin:14px 0 16px}.banner{padding:12px 24px!important;margin-bottom:12px!important}.card{padding:20px 24px!important}.field{margin-bottom:10px}.field .in{padding:9px 14px}.btn{padding:12px 28px}table th,table td{padding:12px 16px}'''
def sw(k):
  a,b=('sel','') if k=='d' else ('','sel')
  return f'<span class="sw" role="radiogroup" aria-label="介面主題"><span class="{a}">● 北歐</span><span class="{b}">● 義式</span></span>'
def shell(k,t,body):
  c=css(k,t)+EXTRA+(COMPACT_E if k=='e' else '').replace('RADC','999px' if k=='d' else '0').replace('RAD','14px' if k=='d' else '0')
  if k=='d':
    s=f'''<div style="display:flex;height:900px"><aside style="width:240px;background:{t['side']};color:#2E2A24;padding:40px 28px;position:relative"><div class="serif" style="font-size:26px;line-height:1.3">應用<br>語意防禦</div><div class="eyebrow" style="color:#33291F;margin:6px 0 48px">Semantic Defense</div>'''+''.join(f'<div style="padding:10px 16px;margin-bottom:6px;border-radius:999px;{"background:#FBF8F2;font-weight:700" if i==0 else ""}">{n}</div>' for i,n in enumerate(NAV))+f'''<div style="position:absolute;bottom:36px;left:28px;font-size:13px"><div style="margin-bottom:12px">{sw(k)}</div>陳美玲 · 應用負責人</div></aside><main style="flex:1;padding:48px 72px">{body}</main></div>'''
  else:
    s=f'''<header style="height:84px;display:flex;align-items:center;padding:0 96px;border-bottom:1px solid var(--color-border);background:var(--color-surface)"><span class="serif" style="font-size:24px;letter-spacing:.12em">SEMANTICA <span style="font-size:16px" class="mu">應用語意防禦</span></span><nav style="margin-left:auto;display:flex;gap:40px;align-items:center">'''+''.join(f'<span style="{"border-bottom:2px solid var(--color-primary);color:var(--color-primary)" if i==0 else "color:var(--color-text-muted)"};padding-bottom:4px">{n}</span>' for i,n in enumerate(NAV))+f'''{sw(k)}<span class="mu">陳美玲</span></nav></header><main style="padding:26px 96px">{body}</main>'''
  return f'<!doctype html><html lang="zh-Hant" data-theme="{"nordic" if k=="d" else "italian"}"><head><meta charset="utf-8"><style>{c}</style></head><body>{s}</body></html>'
def page(k,t,st):
  steps=['1 基本資料','2 入口設定','3 等待合法事件','4 完成接入']
  cur={'empty':0,'loading':2,'no-events':2,'received':3,'error':2}[st]
  stp='<div class="steps">'+''.join(f'<div class="step {"done" if i<cur else "on" if i==cur else ""}">{"✓ " if i<cur else ""}{s}</div>' for i,s in enumerate(steps))+'</div>'
  head=f'<div class="eyebrow">應用接入 / 新增</div><div style="display:flex;align-items:center;gap:18px"><h1 style="margin:0">接入新應用</h1><span class="observe" role="status">◉ 只觀察模式</span></div><p class="mu" style="margin:6px 0 0;font-size:14px">接入後只收事件、建立地圖，不產生限制草案、不呼叫模型。</p>'
  empty_form=st=='empty'
  form=f'''<div class="card" style="flex:1;padding:28px"><div class="eyebrow" style="margin-bottom:14px">應用資料</div>
<div class="field"><div class="lab">應用名稱 *</div><div class="in" {"style='color:var(--color-text-muted)'" if empty_form else ""}>{"例如：訂單系統" if empty_form else "訂單系統"}</div></div>
<div class="field"><div class="lab">應用代號（app_id）*</div><div class="in" {"style='color:var(--color-text-muted)'" if empty_form else ""}>{"英數與連字號，例如 orders" if empty_form else "orders"}</div></div>
<div class="field"><div class="lab">事件來源 *</div><div class="in">{"請選擇：應用反向代理／存取紀錄" if empty_form else "應用反向代理（解開連線的入口）"}</div></div>
<p class="mu" style="font-size:13px;margin:0">入口權杖由平台管理員於控制程序設定，不在此畫面顯示。</p></div>'''
  btn_dis=st!='received'
  reason={'empty':'請先填完應用資料。','loading':'正在確認事件…','no-events':'尚未收到合法事件，至少需要 1 筆才能完成接入。','error':'尚未收到合法事件，至少需要 1 筆才能完成接入。','received':''}[st]
  if st=='loading':
    ev='<div class="card" style="width:520px" aria-busy="true"><div class="eyebrow">事件接收</div><div class="sk" style="width:40%;height:48px;margin:18px 0"></div><div class="sk"></div><div class="sk" style="width:80%"></div><div class="sk" style="width:60%"></div><p class="mu" style="font-size:13px">正在讀取事件筆數…</p></div>'
  elif st=='empty':
    ev='<div class="card" style="width:520px;text-align:center;padding:56px 32px"><div class="eyebrow">事件接收</div><div class="serif" style="font-size:26px;margin:22px 0 10px">尚未開始接收</div><p class="mu">填完應用資料並儲存後，<br>這裡會即時顯示入口送來的事件。</p></div>'
  else:
    n={'no-events':'0','received':'128','error':'0'}[st]
    last={'no-events':'—','received':'2026-11-09 15:18:42（UTC+8）','error':'—'}[st]
    rows=''
    if st=='received':
      rows='<table style="margin-top:8px"><tr><th>時間</th><th>路徑樣板</th><th>類型</th></tr>'+''.join(f'<tr><td class="mu">{a}</td><td>{b}</td><td><span class="tag {c}">{d}</span></td></tr>' for a,b,c,d in [('15:18:42','/orders/{id}','ti','read'),('15:18:39','/orders','tw','write'),('15:18:31','/login','tm','auth')])+'</table>'
    elif st=='error':
      rows='<p class="mu" style="font-size:13px;margin-top:16px">已拒收 3 筆不合法事件（不計入筆數）。</p>'
    else:
      rows='<p class="mu" style="font-size:13px;margin-top:16px">等待入口送來第一筆事件… 每 5 秒自動更新。<br>請在應用上操作任一功能（例如開啟訂單頁）以產生事件。</p>'
    ev=f'''<div class="card" style="width:520px" aria-live="polite"><div class="eyebrow">事件接收</div><div style="display:flex;gap:40px;margin-top:12px"><div><div class="mu" style="font-size:13px">合法事件筆數</div><div class="stat">{n}</div></div><div><div class="mu" style="font-size:13px">最後一筆時間</div><div style="font-size:18px;margin-top:14px">{last}</div></div></div>{rows}</div>'''
  ban={'empty':'','loading':'',
   'no-events':'<div class="banner bi" style="margin-bottom:20px"><b>等待事件</b><span>應用已儲存。入口送來合法事件後即可完成接入。</span></div>',
   'received':'<div class="banner bs" style="margin-bottom:20px"><b>已收到合法事件</b><span>可以完成接入。完成後此應用以「只觀察」模式運作。</span></div>',
   'error':'<div class="banner bd" style="margin-bottom:10px;padding:12px 24px" role="alert"><b>收到不合法事件</b><span>3 筆含不允許的欄位（參數值、本文或標頭），已整份拒收。請檢查入口設定。</span></div><div class="banner bw" style="margin-bottom:16px;padding:12px 24px"><b>入口連線失敗</b><span>最近 2 分鐘無法連上「orders 反向代理」。<u>重新連線</u></span></div>'}[st]
  foot=f'''<div style="margin-top:24px;display:flex;align-items:center;gap:20px"><span class="btn {"g" if btn_dis else "p"}" {"aria-disabled='true' aria-describedby='why'" if btn_dis else ""}>完成接入</span><span class="btn" style="border-color:var(--color-border);color:var(--color-text)">稍後再完成</span>{f'<span id="why" class="mu" style="font-size:14px">ⓘ {reason}</span>' if reason else ''}</div>'''
  if st=='error': head=head.replace('<p class="mu" style="margin:6px 0 0','<p class="mu" style="margin:4px 0 0')
  body=head+stp+ban+f'<div style="display:flex;gap:28px">{form}{ev}</div>'+foot
  return shell(k,t,body)
here=os.path.dirname(os.path.abspath(__file__))
for k,name in [('d','nordic'),('e','italian')]:
  for st in ['no-events','received','loading','empty','error']:
    open(os.path.join(here,f'apps-new-{name}-{st}.html'),'w').write(page(k,T[k],st))
