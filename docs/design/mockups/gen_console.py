# 管理主控台視覺稿（僅 D 北歐溫潤）：頂部頁籤 + 左側樹狀選單、儀表板小工具、
# 密集表格、威脅日誌、狀態燈、案件詳情、AI 助理側欄與對話紀錄。
# 不使用任何廠商品牌、商標、配色或畫面。產出 1440×900 PNG，數字用 Noto Sans Mono 斜線 0。
# 本機模型名稱全稿統一為 Llama 3.1 8B。AI 只建議、不自行封鎖或核准。
import os, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = 'Llama 3.1 8B'
MODEL_L = 'Llama 3.1 8B（本機）'

T = dict(
    bg='#F4EFE6', sf='#FBF8F2', sf2='#ECE4D6', bd='#D9CDB8',
    tx='#2E2A24', mu='#5F574B', pr='#4F6B57', pron='#FFFFFF',
    dan='#9E3B2C', war='#8A5A12', ok='#3F6B4A', inf='#3E5F78',
    neu='#6B6358', wood_from='#D2B288', wood_to='#C6A072',
    on_wood='#33291F', r='18px',
)

CSS = f"""
:root{{
  --color-bg:{T['bg']};--color-surface:{T['sf']};--color-surface-2:{T['sf2']};
  --color-border:{T['bd']};--color-text:{T['tx']};--color-text-muted:{T['mu']};
  --color-primary:{T['pr']};--color-danger:{T['dan']};--color-warning:{T['war']};
  --color-success:{T['ok']};--color-info:{T['inf']};--color-neutral:{T['neu']};
  --color-wood-from:{T['wood_from']};--color-wood-to:{T['wood_to']};
  --color-on-wood:{T['on_wood']};--radius-md:{T['r']};
  --font-serif:"Cormorant Garamond","Noto Serif CJK TC","Noto Serif TC",serif;
  --font-sans:"Noto Sans CJK TC","Noto Sans TC",sans-serif;
  --font-mono:"Noto Sans Mono","Noto Sans Mono CJK TC",ui-monospace,monospace;
}}
*{{box-sizing:border-box}}
html,body{{margin:0;width:1440px;height:900px;overflow:hidden;background-color:var(--color-bg);
  background-image:radial-gradient(rgba(120,95,60,.05) 1px,transparent 1px),repeating-linear-gradient(90deg,rgba(150,110,60,.025) 0 2px,transparent 2px 7px);
  background-size:5px 5px,auto;color:var(--color-text);font:13px/1.45 var(--font-sans);letter-spacing:.01em}}
.serif{{font-family:var(--font-serif);font-weight:600}}
.mono{{font-family:var(--font-mono);font-feature-settings:"zero" 1;font-variant-numeric:lining-nums tabular-nums slashed-zero;letter-spacing:0}}
.mu{{color:var(--color-text-muted)}}
.app{{display:flex;flex-direction:column;width:1440px;height:900px;position:relative}}
.top{{height:52px;flex:none;display:flex;align-items:center;gap:16px;padding:0 20px;
  background:linear-gradient(180deg,var(--color-wood-from),var(--color-wood-to));color:var(--color-text);
  position:relative}}
.top::after{{content:"";position:absolute;inset:0;pointer-events:none;
  background:repeating-linear-gradient(92deg,rgba(90,60,30,.08) 0 3px,transparent 3px 19px)}}
.top > *{{position:relative}}
.brand{{font-family:var(--font-serif);font-weight:600;font-size:22px;line-height:1;color:var(--color-on-wood);letter-spacing:.04em}}
.mode-pill{{display:inline-flex;align-items:center;gap:8px;background:var(--color-surface);color:var(--color-text);
  border:1px solid var(--color-border);border-radius:999px;padding:4px 12px;font-size:12px;font-weight:700}}
.top-right{{margin-left:auto;display:flex;align-items:center;gap:14px;color:var(--color-on-wood);font-size:13px}}
.ai-entry{{display:inline-flex;align-items:center;gap:6px;background:var(--color-surface);color:var(--color-text);
  border:1px solid var(--color-border);border-radius:999px;padding:3px 10px 3px 5px;font-size:13px;font-weight:700}}
.ai-entry.on{{outline:2px solid var(--color-info);outline-offset:1px}}
.tabs{{height:36px;flex:none;display:flex;align-items:stretch;padding:0 20px;gap:4px;
  background:var(--color-surface);border-bottom:1px solid var(--color-border)}}
.tab{{display:flex;align-items:center;padding:0 16px;color:var(--color-text-muted);font-size:13px}}
.tab.on{{color:var(--color-text);font-weight:700;border-bottom:2px solid var(--color-primary)}}
.body{{flex:1;min-height:0;display:flex}}
.tree{{width:208px;flex:none;background:var(--color-surface-2);border-right:1px solid var(--color-border);
  padding:14px 10px;overflow:hidden}}
.tg{{font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:var(--color-text-muted);padding:8px 10px 4px}}
.ti{{padding:7px 10px;border-radius:999px;color:var(--color-text);margin-bottom:2px}}
.ti.on{{background:var(--color-surface);font-weight:700}}
.ti .count{{float:right;font-family:var(--font-mono);font-feature-settings:"zero" 1;font-variant-numeric:lining-nums tabular-nums slashed-zero;color:var(--color-text-muted)}}
.ti.on .count{{color:var(--color-text)}}
.ti.dim{{color:var(--color-text-muted)}}
main{{flex:1;min-width:0;min-height:0;overflow:hidden;display:flex;flex-direction:column;padding:12px 18px 12px}}.app.has-fab main{{padding-bottom:56px}}
.pagehead{{display:flex;align-items:baseline;gap:16px;flex:none;margin-bottom:6px}}
h1{{font-family:var(--font-serif);font-weight:600;font-size:26px;line-height:1.15;margin:0;letter-spacing:.03em}}
.eyebrow{{font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:var(--color-text-muted)}}
.card{{background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-md);padding:10px 14px}}
.featured{{border:1px solid color-mix(in srgb,var(--color-primary) 35%,var(--color-border));
  box-shadow:inset 4px 0 0 var(--color-primary)}}
.ai-panel{{border:1px solid color-mix(in srgb,var(--color-info) 40%,var(--color-border));
  box-shadow:inset 4px 0 0 var(--color-info);background:var(--color-surface)}}
table{{width:100%;border-collapse:collapse;table-layout:fixed}}
th,td{{text-align:left;padding:6px 8px;border-bottom:1px solid var(--color-border);vertical-align:middle;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}}
td.mono{{text-overflow:clip}}
td.wrap{{white-space:normal;overflow:visible;text-overflow:unset;line-height:1.4;vertical-align:top}}
tr.tall td{{vertical-align:top;padding-top:8px;padding-bottom:8px}}
th{{font-weight:500;font-size:11px;letter-spacing:.12em;color:var(--color-text-muted);text-transform:uppercase}}
tr:last-child td{{border-bottom:0}}
.tag{{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600;line-height:1.4}}
.td{{color:var(--color-danger);background:color-mix(in srgb,var(--color-danger) 10%,var(--color-surface))}}
.tw{{color:var(--color-warning);background:color-mix(in srgb,var(--color-warning) 12%,var(--color-surface))}}
.ts{{color:var(--color-success);background:color-mix(in srgb,var(--color-success) 12%,var(--color-surface))}}
.ti-tag{{color:var(--color-info);background:color-mix(in srgb,var(--color-info) 10%,var(--color-surface))}}
.tm{{color:var(--color-neutral);background:var(--color-surface-2)}}
.btn{{display:inline-block;padding:4px 12px;border-radius:999px;font-weight:600;font-size:12px;border:1px solid var(--color-text);line-height:1.35;letter-spacing:.02em}}
.p{{background:var(--color-primary);border-color:var(--color-primary);color:{T['pron']}}}
.o{{color:var(--color-danger);border-color:var(--color-danger);background:transparent}}
.g{{background:var(--color-surface-2);color:var(--color-neutral);border-color:var(--color-border)}}
.banner{{padding:8px 12px;border-radius:12px;display:flex;gap:10px;align-items:center;border:1px solid;margin:0 0 8px}}
.bw{{color:var(--color-warning);border-color:var(--color-warning);background:color-mix(in srgb,var(--color-warning) 8%,var(--color-surface))}}
.bi{{color:var(--color-info);border-color:var(--color-info);background:color-mix(in srgb,var(--color-info) 7%,var(--color-surface))}}
.bs{{color:var(--color-success);border-color:var(--color-success);background:color-mix(in srgb,var(--color-success) 8%,var(--color-surface))}}
.led{{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle;flex:none}}
.led.ok{{background:var(--color-success)}}
.led.war{{background:var(--color-warning)}}
.led.dan{{background:var(--color-danger)}}
.led.inf{{background:var(--color-info)}}
.kpis{{display:flex;gap:8px}}
.kpi{{flex:1;background:color-mix(in srgb,var(--color-surface-2) 55%,var(--color-surface));border:1px solid var(--color-border);border-radius:14px;padding:8px 12px}}
.kpi .n{{font-family:var(--font-mono);font-feature-settings:"zero" 1;font-variant-numeric:lining-nums tabular-nums slashed-zero;font-size:26px;line-height:1.1;font-weight:600}}
.kpi .l{{font-size:12px;margin-bottom:2px}}
.row{{display:flex;gap:10px;min-height:0}}
.grow{{flex:1;min-height:0;min-width:0}}
h2{{font-family:var(--font-serif);font-weight:600;font-size:16px;margin:0 0 6px;letter-spacing:.03em}}
.chip{{display:inline-flex;align-items:center;gap:3px;padding:1px 7px 1px 5px;border-radius:999px;font-size:11px;font-weight:700;line-height:1.35;letter-spacing:.06em;vertical-align:middle}}
.chip.ai{{background:var(--color-info);color:#FFFFFF}}
.chip.rule{{background:var(--color-neutral);color:#FFFFFF}}
.spark{{position:relative;width:8px;height:8px;flex:none}}
.spark::before,.spark::after{{content:"";position:absolute;background:#FFFFFF;left:50%;top:50%}}
.spark::before{{width:8px;height:2px;margin:-1px 0 0 -4px}}
.spark::after{{width:2px;height:8px;margin:-4px 0 0 -1px}}
.reason{{color:var(--color-text-muted);font-size:12px;line-height:1.4;margin-top:3px;white-space:normal}}
.ai-launch{{position:absolute;right:20px;bottom:16px;z-index:20;display:inline-flex;align-items:center;gap:8px;
  background:var(--color-info);color:#FFFFFF;border-radius:999px;padding:8px 16px 8px 10px;font-weight:700;font-size:13px;
  border:1px solid var(--color-info);box-shadow:0 2px 8px rgba(46,42,36,.18)}}
.sidepanel{{width:400px;flex:none;background:var(--color-surface);border-left:1px solid var(--color-border);
  display:flex;flex-direction:column;min-height:0;overflow:hidden}}
.sp-head{{flex:none;display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--color-border)}}
.sp-note{{flex:none;font-size:12px;color:var(--color-text-muted);padding:8px 14px;line-height:1.45;background:color-mix(in srgb,var(--color-info) 7%,var(--color-surface));border-bottom:1px solid var(--color-border)}}
.ctx{{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:700;
  color:var(--color-info);background:color-mix(in srgb,var(--color-info) 10%,var(--color-surface));border:1px solid color-mix(in srgb,var(--color-info) 30%,var(--color-border))}}
.msgs{{flex:1;min-height:0;overflow:hidden;padding:12px 14px}}
.msg{{margin:0 0 10px;max-width:94%;padding:8px 10px;line-height:1.5}}
.msg .who{{font-size:11px;margin-bottom:3px}}
.msg.me{{margin-left:auto;background:var(--color-surface-2);border-radius:12px 12px 4px 12px}}
.msg.bot{{background:color-mix(in srgb,var(--color-info) 7%,var(--color-surface));border:1px solid color-mix(in srgb,var(--color-info) 25%,var(--color-border));border-radius:12px 12px 12px 4px}}
.disclaimer{{font-size:12px;color:var(--color-text-muted);margin-top:6px;line-height:1.4}}
.sp-input{{flex:none;margin:0 14px 12px;border:1px solid var(--color-border);border-radius:14px;padding:10px 12px;color:var(--color-text-muted);background:var(--color-surface-2)}}
.fact{{display:flex;gap:12px;padding:6px 0;border-bottom:1px solid var(--color-border)}}
.fact:last-child{{border-bottom:0}}
.fact .k{{width:92px;flex:none;color:var(--color-text-muted);font-size:12px}}
.fact .v{{flex:1;min-width:0}}
.ev{{margin:0;padding:0 0 0 18px}}
.ev li{{margin:0 0 6px}}
.sel-row td{{background:color-mix(in srgb,var(--color-info) 8%,var(--color-surface))}}
"""

TABS = ['儀表板', '封鎖與審核', '告警與健康', '判斷紀錄', '應用']
DISCLAIM = 'AI 不會自行封鎖或核准，需由人員確認。'
SYS_TREE = ('系統', [('告警與健康', None), ('元件狀態', None), ('AI 對話紀錄', None)])

def chip_ai():
    return '<span class="chip ai"><span class="spark" aria-hidden="true"></span>AI</span>'


def chip_rule():
    return '<span class="chip rule">規則</span>'


def shell(active_tab, tree_html, body, clock='2026-11-17 14:52:08', launcher=True, panel='', ai_on=False):
    tabs = ''.join(
        f'<div class="tab {"on" if t==active_tab else ""}">{t}</div>' for t in TABS
    )
    entry = f'<div class="ai-entry {"on" if ai_on else ""}">{chip_ai()} 助理</div>'
    fab = f'<div class="ai-launch">{chip_ai()} 詢問 AI</div>' if launcher and not panel else ''
    app_cls = "app has-fab" if (launcher and not panel) else "app"
    return f'''<!doctype html><html lang="zh-Hant" data-theme="nordic"><head><meta charset="utf-8"><style>{CSS}</style></head>
<body><div class="{app_cls}">
  <header class="top">
    <div class="brand">應用語意防禦</div>
    <div class="mode-pill"><span class="led ok"></span>只接收鏡像流量</div>
    <div class="top-right">{entry}<span class="mono">{clock}</span><span>王小明 · 值勤中</span></div>
  </header>
  <nav class="tabs">{tabs}</nav>
  <div class="body">
    <aside class="tree">{tree_html}</aside>
    <main>{body}</main>
    {panel}
  </div>
  {fab}
</div></body></html>'''


def tree(groups, active):
    out = []
    for title, items in groups:
        out.append(f'<div class="tg">{title}</div>')
        for it in items:
            if isinstance(it, tuple):
                name, count, dim = (it + (False,))[:3] if len(it) == 2 else it
            else:
                name, count, dim = it, None, False
            cls = 'ti' + (' on' if name == active else '') + (' dim' if dim and name != active else '')
            c = f'<span class="count">{count}</span>' if count is not None else ''
            out.append(f'<div class="{cls}">{name}{c}</div>')
    return ''.join(out)


# Shared fictional cases (connection-behavior reasons only)
CASES = [
    dict(id='C-2416', time='14:51:02', src='203.0.113.18', dst='會員 API (TCP 443)',
         method='短時間輪換手法試探', conf='0.87', cidr='203.0.113.18/32',
         reason='連線間隔穩定 <span class="mono">0.2</span> 秒、短時間輪換手法，疑似自動化工具',
         disp='待審', tag='tw', auto=False),
    dict(id='C-2415', time='14:50:41', src='198.51.100.20', dst='客服 API (TCP 443)',
         method='機器式規律掃描', conf='0.73', cidr='198.51.100.20/32',
         reason='<span class="mono">15</span> 分鐘內對 <span class="mono">42</span> 個目的端依序連線，間隔偏差小於 <span class="mono">50</span> 毫秒',
         disp='待審', tag='tw', auto=False),
    dict(id='C-2414', time='14:49:16', src='203.0.113.44', dst='<span class="mono">192.0.2.10:443</span>',
         method='異常上傳量', conf='0.94', cidr='203.0.113.44/32',
         reason='<span class="mono">6</span> 分鐘內上傳量較七日基線高 <span class="mono">22</span> 倍，連線節奏固定',
         disp='已自動上榜', tag='ts', auto=True),
    dict(id='C-2413', time='14:47:55', src='192.0.2.80', dst='人資入口 (TCP 443)',
         method='多目標快速切換', conf='0.81', cidr='192.0.2.80/32',
         reason='<span class="mono">90</span> 秒內切換 <span class="mono">11</span> 個目的端，不符合人工操作節奏',
         disp='待審', tag='tw', auto=False),
    dict(id='C-2409', time='14:44:29', src='2001:db8::40', dst='<span class="mono">[2001:db8::10]:443</span>',
         method='固定間隔連線探測', conf='0.91', cidr='2001:db8::40/128',
         reason='連續 <span class="mono">120</span> 次連線間隔均為 <span class="mono">0.50</span> 秒，偏差小於 <span class="mono">10</span> 毫秒',
         disp='已自動上榜', tag='ts', auto=True),
    dict(id='C-2412', time='14:46:08', src='203.0.113.7', dst='會員 API (TCP 443)',
         method='短時間密集連線重試', conf='0.66', cidr='203.0.113.7/32',
         reason='對單一目的端在 <span class="mono">40</span> 秒內重試 <span class="mono">63</span> 次，失敗後間隔仍保持穩定',
         disp='待審', tag='tw', auto=False),
    dict(id='C-2410', time='14:22:19', src='198.51.100.66', dst='金流 API (TCP 443)',
         method='穩定間隔的暴力登入', conf='0.58', cidr='198.51.100.66/32',
         reason='連線間隔穩定 <span class="mono">1.0</span> 秒，連續 <span class="mono">86</span> 次嘗試同一目的埠',
         disp='待審', tag='tw', auto=False),
    dict(id='C-2408', time='14:05:33', src='192.0.2.15', dst='<span class="mono">192.0.2.30:443</span>',
         method='異常上傳量', conf='0.64', cidr='192.0.2.15/32',
         reason='對目的端上傳量較七日基線高 <span class="mono">18</span> 倍，連線時長偏短',
         disp='待審', tag='tw', auto=False),
]


def dashboard():
    tr = tree([
        ('監看', [('儀表板', None), ('AI 判斷', None), ('威脅紀錄', None)]),
        ('封鎖', [('待審佇列', 6), ('已上榜封鎖', 37)]),
        SYS_TREE,
    ], '儀表板')
    dets = [CASES[0], CASES[1], CASES[2], CASES[3]]
    det_rows = ''.join(
        f'<tr class="tall"><td class="mono">{c["time"]}</td><td class="mono">{c["src"]}</td>'
        f'<td>{c["dst"]}</td><td class="wrap">{chip_ai()} {c["method"]}<div class="reason">{c["reason"]}</div></td>'
        f'<td class="mono">{c["conf"]}</td><td><span class="tag {c["tag"]}">{c["disp"]}</span></td></tr>'
        for c in dets
    )
    logs = [
        ('14:51:02', '注意', 'war', '203.0.113.18', '會員 API (TCP 443)', f'{chip_ai()} 短時間輪換手法試探（信心 <span class="mono">0.87</span>）', '送待審'),
        ('14:49:16', '高', 'td', '203.0.113.44', '<span class="mono">192.0.2.10:443</span>', f'{chip_ai()} 異常上傳量（信心 <span class="mono">0.94</span>）', '自動上榜 24 小時'),
        ('14:36:08', '注意', 'war', '198.51.100.9', '客服 API (TCP 443)', f'{chip_rule()} 已知掃描前綴重連，間隔符合既有規則', '已記錄，未成案'),
    ]
    log_rows = ''.join(
        f'<tr><td class="mono">{a}</td><td><span class="tag {c}">{b}</span></td><td class="mono">{d}</td>'
        f'<td>{e}</td><td class="wrap">{f}</td><td>{g}</td></tr>'
        for a, b, c, d, e, f, g in logs
    )
    body = f'''
    <div class="pagehead"><div><div class="eyebrow">監看 / 總覽</div><h1>儀表板</h1></div>
      <span class="mu" style="margin-left:auto">今日 <span class="mono">00:00</span> 起 · Asia/Taipei · 每 5 秒更新</span></div>
    <div class="banner bi"><b class="serif" style="font-size:15px">目前模式：只接收鏡像流量</b>
      <span>不解密、不攔截線上連線。以 AI 偵測針對 AI 的攻擊；命中後寫入供防火牆拉取的封鎖清單。</span></div>
    <div class="card featured" style="flex:none;margin-bottom:8px">
      <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:8px">
        <h2 style="margin:0">{chip_ai()} AI 判斷</h2>
        <span class="mu">自動上榜門檻 <span class="mono">≥ 0.90</span>　成案門檻 <span class="mono">≥ 0.50</span>　白名單命中永不上榜</span>
      </div>
      <div class="kpis" style="margin-bottom:8px">
        <div class="kpi"><div class="l"><span class="led ok"></span>自動上榜</div><div class="n" style="color:var(--color-success)">14</div><div class="mu" style="font-size:12px">信心 <span class="mono">≥ 0.90</span></div></div>
        <div class="kpi"><div class="l"><span class="led war"></span>待審</div><div class="n" style="color:var(--color-warning)">6</div><div class="mu" style="font-size:12px">信心 <span class="mono">0.50–0.90</span>，待人工決定</div></div>
        <div class="kpi"><div class="l"><span class="led inf"></span>未成案</div><div class="n" style="color:var(--color-info)">31</div><div class="mu" style="font-size:12px">信心 <span class="mono">&lt; 0.50</span></div></div>
        <div class="kpi"><div class="l"><span class="led inf"></span>白名單略過</div><div class="n" style="color:var(--color-info)">3</div><div class="mu" style="font-size:12px">永不上榜</div></div>
      </div>
      <div class="eyebrow" style="margin-bottom:4px">最近 AI 偵測</div>
      <table>
        <colgroup><col style="width:84px"><col style="width:132px"><col style="width:168px"><col><col style="width:56px"><col style="width:102px"></colgroup>
        <tr><th>時間</th><th>來源</th><th>目的端</th><th>手法與 AI 理由</th><th>信心</th><th>處置</th></tr>
        {det_rows}
      </table>
    </div>
    <div class="kpis" style="flex:none;margin-bottom:8px">
      <div class="card grow" style="padding:8px 12px"><div class="eyebrow">鏡像流量</div>
        <div style="display:flex;align-items:baseline;gap:8px"><span class="mono" style="font-size:24px;font-weight:600">2,184</span><span class="mu">筆／分</span></div>
        <div class="mu" style="font-size:12px"><span class="led ok"></span>接收正常 · 最後一筆 <span class="mono">0.8</span> 秒前</div></div>
      <div class="card grow" style="padding:8px 12px"><div class="eyebrow">生效封鎖</div>
        <div style="display:flex;align-items:baseline;gap:8px"><span class="mono" style="font-size:24px;font-weight:600">37</span><span class="mu">筆</span></div>
        <div class="mu" style="font-size:12px">今日自動 <span class="mono">11</span> · 人工 <span class="mono">2</span> · <span class="mono">24</span> 小時內到期 <span class="mono">12</span></div></div>
      <div class="card grow" style="padding:8px 12px"><div class="eyebrow">系統健康</div>
        <div class="serif" style="font-size:20px;color:var(--color-warning)">注意</div>
        <div class="mu" style="font-size:12px"><span class="led war"></span>模型連線延遲偏高 · 其餘 7 項正常</div></div>
      <div class="card grow" style="flex:1.7;padding:8px 12px">
        <div style="display:flex;align-items:center;gap:8px"><span class="eyebrow" style="margin:0">AI 引擎狀態</span>{chip_ai()}
          <span style="margin-left:auto;font-weight:700;color:var(--color-warning)"><span class="led war"></span>注意</span></div>
        <div style="margin:4px 0 2px">{MODEL_L}</div>
        <div class="mu" style="font-size:12px">今日已分析 <span class="mono">54</span>　與規則不一致 <span class="mono">2</span>　平均回應 <span class="mono">4.8</span> 秒</div>
      </div>
    </div>
    <div class="card grow" style="display:flex;flex-direction:column;min-height:0;padding:8px 14px">
      <div style="display:flex;align-items:baseline"><h2 style="margin:0">威脅紀錄</h2><span class="mu" style="margin-left:auto">僅中繼資料，不保存封包內容 · {chip_ai()} 與 {chip_rule()} 分開標示</span></div>
      <table style="margin-top:4px">
        <colgroup><col style="width:84px"><col style="width:70px"><col style="width:132px"><col style="width:168px"><col><col style="width:140px"></colgroup>
        <tr><th>時間</th><th>等級</th><th>來源</th><th>目的端</th><th>事件</th><th>處置</th></tr>
        {log_rows}
      </table>
    </div>
    '''
    return shell('儀表板', tr, body)


def blocklist():
    tr = tree([
        ('封鎖', [('待審佇列', 6), ('已上榜封鎖', 37), ('已撤回', 9)]),
        ('存取例外', [('白名單', None, True)]),
        SYS_TREE,
    ], '待審佇列')
    pending = [CASES[0], CASES[1], CASES[3], CASES[5], CASES[6], CASES[7]]
    p_rows = ''.join(
        f'<tr class="tall"><td class="mono">{c["id"]}</td><td class="mono">{c["time"]}</td>'
        f'<td class="mono">{c["src"]}</td><td>{c["dst"]}</td>'
        f'<td class="wrap">{chip_ai()} {c["method"]}<div class="reason">{c["reason"]}</div></td>'
        f'<td class="mono">{c["conf"]}</td><td class="mono">{c["cidr"]}</td><td>24 小時</td>'
        f'<td><span class="btn p">核准</span> <span class="btn o">駁回</span></td></tr>'
        for c in pending
    )
    active = [
        ('203.0.113.44/32', f'{chip_ai()} 自動', '0.94', '14:49:16', '11-18 14:49', '生效'),
        ('2001:db8::40/128', f'{chip_ai()} 自動', '0.91', '14:44:29', '11-18 14:44', '生效'),
        ('203.0.113.102/32', f'{chip_ai()} 人工 · 王小明', '0.88', '13:10:04', '11-18 13:10', '生效'),
        ('198.51.100.09/32', f'{chip_rule()} 自動', '0.96', '12:02:41', '11-18 12:02', '生效'),
    ]
    a_rows = ''.join(
        f'<tr><td class="mono">{a}</td><td class="wrap">{b}</td><td class="mono">{c}</td>'
        f'<td class="mono">{d}</td><td class="mono">{e}</td><td>{f}</td>'
        f'<td><span class="btn o">撤回</span></td></tr>'
        for a, b, c, d, e, f in active
    )
    body = f'''
    <div class="pagehead"><div><div class="eyebrow">封鎖 / 待審佇列</div><h1>封鎖與審核</h1></div>
      <span class="mu" style="margin-left:auto">值班可核准或駁回；白名單僅平台管理可改</span></div>
    <div class="banner bw"><b class="serif" style="font-size:15px">6 件待審</b>
      <span>信心 <span class="mono">0.50–0.90</span> 須人工決定。{chip_ai()} 只提供理由與建議，不會自行封鎖或核准。</span></div>
    <div class="card" style="flex:none;margin-bottom:8px;padding:8px 12px">
      <div style="display:flex;align-items:baseline;margin-bottom:4px"><h2 style="margin:0">待審佇列</h2>
        <span class="mu" style="margin-left:auto">依成案時間排列 · 準時路徑 7 秒內可核准</span></div>
      <table>
        <colgroup><col style="width:68px"><col style="width:78px"><col style="width:124px"><col style="width:148px"><col><col style="width:48px"><col style="width:148px"><col style="width:78px"><col style="width:124px"></colgroup>
        <tr><th>案件</th><th>成案</th><th>來源</th><th>目的端</th><th>手法與 AI 理由</th><th>信心</th><th>建議封鎖</th><th>期間</th><th>動作</th></tr>
        {p_rows}
      </table>
    </div>
    <div class="card grow" style="display:flex;flex-direction:column;min-height:0;padding:8px 12px">
      <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:4px">
        <h2 style="margin:0">已上榜封鎖</h2>
        <span class="tag tm">全部 37</span><span class="tag ts">自動 28</span><span class="tag ti-tag">人工 9</span>
        <span class="mu" style="margin-left:auto">來源以 {chip_ai()} 或 {chip_rule()} 標示</span>
      </div>
      <table>
        <colgroup><col style="width:180px"><col style="width:170px"><col style="width:64px"><col style="width:100px"><col style="width:110px"><col style="width:70px"><col style="width:80px"></colgroup>
        <tr><th>IP / CIDR</th><th>來源</th><th>信心</th><th>上榜</th><th>到期</th><th>狀態</th><th>動作</th></tr>
        {a_rows}
      </table>
    </div>
    '''
    return shell('封鎖與審核', tr, body)

def alerts():
    tr = tree([
        ('系統', [('告警與健康', None), ('元件狀態', None), ('未解除告警', 1), ('AI 對話紀錄', None)]),
        ('紀錄', ['稽核']),
    ], '告警與健康')
    comps = [
        ('ok', '鏡像接收', '正常', '最後一筆 <span class="mono">0.8</span> 秒前 · 今日中斷已恢復'),
        ('ok', '判定程序', '正常', '新判斷進行中；已生效封鎖仍由防火牆執行'),
        ('war', '模型連線', '注意', '回應 <span class="mono">4.8</span> 秒，超過 <span class="mono">4</span> 秒門檻'),
        ('ok', 'EDL 發布', '正常', '已發布 <span class="mono">37</span> 筆 · 上限 <span class="mono">500</span>，未截斷'),
        ('ok', '控制 API', '正常', '工作階段簽發與核准寫入正常'),
        ('ok', '資料庫', '正常', '複寫延遲 <span class="mono">12</span> 毫秒'),
        ('ok', '簽章金鑰', '正常', '目前金鑰未到期'),
        ('inf', '運作模式', '鏡像', '只接收鏡像流量，不解密、不攔截'),
    ]
    tiles = ''.join(
        f'<div class="card" style="padding:10px 12px"><div class="l" style="font-size:12px;color:var(--color-text-muted)">{b}</div>'
        f'<div style="margin-top:4px;font-weight:700;color:var(--color-{"success" if a=="ok" else "warning" if a=="war" else "info"})">'
        f'<span class="led {a}"></span>{c}</div><div class="mu" style="font-size:12px;margin-top:2px">{d}</div></div>'
        for a, b, c, d in comps
    )
    alerts_rows = [
        ('14:48:11', '注意', 'war', '模型連線', '判定耗時 4.8 秒，超過 4 秒門檻，畫面曾顯示尚無結果。黑名單未變更。', '未解除'),
        ('14:12:06', '資訊', 'ti-tag', 'EDL 發布', '清單 37 筆，上限 500，用量正常，未截斷。', '已確認'),
        ('13:05:40', '注意', 'war', '鏡像接收', '金流網段鏡像中斷 46 秒，13:06:26 已恢復。', '已解除'),
        ('11:18:02', '資訊', 'ti-tag', '運作模式', '平台管理員將模式維持在「只接收鏡像流量」。', '已確認'),
        ('昨天 22:14', '注意', 'war', '判定程序', '模型短暫無回應 11 秒後自動重試成功。新判斷未暫停。', '已解除'),
        ('昨天 16:40', '高', 'td', 'EDL 發布', '演練：接近上限時應告警且不截斷（本次為演練，實際 37 筆）。', '已確認'),
    ]
    a_rows = ''.join(
        f'<tr><td class="mono">{a}</td><td><span class="tag {c}">{b}</span></td><td>{d}</td><td style="white-space:normal">{e}</td>'
        f'<td>{"<span class=\'tag tw\'>未解除</span>" if f=="未解除" else f}</td></tr>'
        for a, b, c, d, e, f in alerts_rows
    )
    body = f'''
    <div class="pagehead"><div><div class="eyebrow">系統 / 狀態</div><h1>告警與健康</h1></div>
      <span class="mu" style="margin-left:auto">狀態以文字與狀態燈同時標示，不只靠顏色</span></div>
    <div class="banner bw"><b class="serif" style="font-size:15px">1 件未解除：模型連線注意</b>
      <span>判定程序仍在運作。若判定停止，此處會改為「新判斷已暫停；已生效封鎖仍由防火牆執行」。</span></div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:10px;flex:none">{tiles}</div>
    <div class="card grow" style="display:flex;flex-direction:column;min-height:0;padding:10px 12px">
      <div style="display:flex;align-items:baseline"><h2 style="margin:0">告警清單</h2>
        <span class="mu" style="margin-left:auto">依時間新到舊 · 未解除置頂</span></div>
      <table style="margin-top:4px">
        <colgroup><col style="width:110px"><col style="width:70px"><col style="width:92px"><col><col style="width:80px"></colgroup>
        <tr><th>時間</th><th>等級</th><th>來源</th><th>說明</th><th>狀態</th></tr>
        {a_rows}
      </table>
    </div>
    '''
    return shell('告警與健康', tr, body)


def login():
    return f'''<!doctype html><html lang="zh-Hant" data-theme="nordic"><head><meta charset="utf-8"><style>{CSS}
.login{{display:flex;height:900px;width:1440px}}
.wood{{flex:1;background:linear-gradient(180deg,var(--color-wood-from),var(--color-wood-to));position:relative;color:var(--color-text)}}
.wood .grain{{position:absolute;inset:0;background:repeating-linear-gradient(92deg,rgba(90,60,30,.08) 0 3px,transparent 3px 19px)}}
.panel{{width:620px;flex:none;display:flex;align-items:center;justify-content:center;background:transparent}}
.field-lab{{font-size:13px;color:var(--color-text-muted);margin-bottom:6px}}
.field-box{{background:var(--color-surface);border:1px solid var(--color-border);border-radius:14px;padding:12px 18px}}
</style></head>
<body>
<div class="login">
  <div class="wood">
    <div class="grain"></div>
    <div style="position:absolute;left:80px;top:72px">
      <div class="brand" style="font-size:26px">應用語意防禦</div>
      <div class="eyebrow" style="color:var(--color-on-wood);margin-top:8px">管理主控台</div>
    </div>
    <div style="position:absolute;left:80px;bottom:90px;color:var(--color-text);max-width:520px">
      <div class="serif" style="font-size:52px;line-height:1.2">安靜地<br>守護每一次請求</div>
      <div style="margin-top:16px;color:var(--color-on-wood);font-size:15px">只接收鏡像流量 · 以 AI 偵測針對 AI 的攻擊</div>
      <div class="eyebrow" style="color:var(--color-on-wood);margin-top:14px">Semantic Defense · Est. 2026</div>
    </div>
  </div>
  <div class="panel">
    <div style="width:400px">
      <div class="eyebrow">Welcome back</div>
      <h1 style="font-size:40px;margin:4px 0 8px">值勤登入</h1>
      <p class="mu" style="margin:0 0 16px;line-height:1.7;font-size:15px">請以公司帳號登入。所有操作將留存稽核紀錄。</p>
      <div class="banner bw" style="margin:0 0 18px;border-radius:14px">工作階段已逾時，請重新登入。</div>
      <div class="field-lab">帳號</div>
      <div class="field-box" style="margin:0 0 16px">wang.xm@corp</div>
      <div class="field-lab">密碼</div>
      <div class="field-box" style="margin:0 0 24px;outline:2px solid var(--color-primary);outline-offset:3px">••••••••••</div>
      <div class="btn p" style="width:100%;text-align:center;padding:12px 32px;font-size:15px">登入</div>
      <p class="mu" style="font-size:12px;margin:16px 0 0">本系統只接收鏡像流量，不解密、不攔截線上連線。</p>
    </div>
  </div>
</div>
</body></html>'''


def chat_transcript():
    return f'''
      <div class="msg me"><div class="who mu">王小明 · <span class="mono">14:51:40</span></div>這件為什麼要送待審？</div>
      <div class="msg bot"><div class="who">{chip_ai()} {MODEL} · <span class="mono">14:51:42</span></div>
        根據連線間隔穩定 <span class="mono">0.2</span> 秒、短時間輪換手法，判斷為疑似自動化工具。信心 <span class="mono">0.87</span>，未達自動上榜門檻 <span class="mono">0.90</span>，因此送入待審。我只能說明理由與建議，不能代為封鎖或核准。</div>
      <div class="msg me"><div class="who mu">王小明 · <span class="mono">14:51:55</span></div>那你建議怎麼處理？</div>
      <div class="msg bot"><div class="who">{chip_ai()} {MODEL} · <span class="mono">14:51:57</span></div>
        建議將 <span class="mono">203.0.113.18/32</span> 列入封鎖 <span class="mono">24</span> 小時，並由值班人員確認。
        <div style="margin-top:8px"><span class="btn p">前往核准</span></div>
        <div class="disclaimer">{DISCLAIM}</div>
      </div>
    '''


def chat_panel():
    return f'''
    <aside class="sidepanel">
      <div class="sp-head">{chip_ai()} <h2 style="margin:0;flex:1">AI 助理</h2>
        <span class="mu" style="font-size:12px">{MODEL_L}</span></div>
      <div class="sp-note">使用本機 {MODEL}。對話留在本機，並寫入稽核紀錄。<div style="margin-top:6px"><span class="ctx">已帶入案件 C-2416</span></div></div>
      <div class="msgs">{chat_transcript()}</div>
      <div class="sp-input">詢問此案件、來源 IP，或今日狀態…</div>
    </aside>'''


def case_body(compact=False):
    facts = [
        ('來源', '<span class="mono">203.0.113.18:51204</span>'),
        ('目的端', '會員 API · <span class="mono">192.0.2.10:443</span>'),
        ('時間窗', '<span class="mono">14:49:16</span>–<span class="mono">14:51:02</span>（<span class="mono">106</span> 秒）'),
        ('連線數', '<span class="mono">147</span> 筆'),
        ('間隔', '中位 <span class="mono">0.20</span> 秒，標準差 <span class="mono">0.03</span> 秒'),
        ('上傳／下載', '<span class="mono">8.4</span> MB / <span class="mono">1.2</span> MB（僅計量，無內容）'),
        ('目的變化', '目的端固定；來源埠短時間輪換 <span class="mono">36</span> 次'),
    ]
    fact_html = ''.join(f'<div class="fact"><div class="k">{k}</div><div class="v">{v}</div></div>' for k, v in facts)
    ev_items = [
        '<span class="mono">106</span> 秒內 <span class="mono">147</span> 筆連線，中位間隔 <span class="mono">0.20</span> 秒，標準差僅 <span class="mono">0.03</span> 秒，節奏過於穩定。',
        '來源埠持續輪換，但目的端始終是 <span class="mono">192.0.2.10:443</span>。',
        '連線時長與重試間隔重複出現，不符合人工操作節奏。',
        '信心 <span class="mono">0.87</span>，低於自動上榜門檻 <span class="mono">0.90</span>，因此建議待審而非自動上榜。',
    ]
    ev_html = '<ul class="ev">' + ''.join(f'<li>{e}</li>' for e in ev_items) + '</ul>'
    analysis = f'''
      <div class="card ai-panel grow" style="display:flex;flex-direction:column;min-height:0">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          {chip_ai()} <h2 style="margin:0">AI 分析</h2>
          <span class="mu" style="margin-left:auto">{MODEL_L}</span>
        </div>
        <div class="eyebrow">信心</div>
        <div class="mono" style="font-size:40px;font-weight:600;line-height:1.1;color:var(--color-warning)">0.87</div>
        <div class="mu" style="font-size:12px;margin:2px 0 10px">成案門檻 <span class="mono">0.50</span>｜自動上榜 <span class="mono">0.90</span></div>
        <div class="eyebrow">建議處置</div>
        <div style="margin:4px 0 10px">建議列入封鎖待審：<span class="mono">203.0.113.18/32</span>，為期 24 小時。</div>
        <div class="eyebrow">依據（僅連線行為特徵）</div>
        {ev_html}
        <div style="margin-top:auto;padding-top:10px">
          <span class="btn p">核准</span> <span class="btn o">駁回</span>
          <div class="disclaimer">{DISCLAIM}</div>
        </div>
      </div>'''
    if compact:
        return f'''
        <div class="pagehead"><div><div class="eyebrow">封鎖 / 待審佇列 / C-2416</div>
          <h1>C-2416　{chip_ai()} <span class="tag tw">待審</span></h1></div></div>
        <div class="card" style="flex:none;margin-bottom:8px">
          <h2>連線事實</h2>
          {fact_html}
        </div>
        <div class="card ai-panel" style="flex:none">
          <div style="display:flex;align-items:center;gap:8px">{chip_ai()} <b>建議列入封鎖待審</b>
            <span class="mono" style="margin-left:auto">0.87</span></div>
          <div class="mu" style="margin-top:4px">{MODEL_L} · 建議 <span class="mono">203.0.113.18/32</span>，24 小時</div>
        </div>'''
    return f'''
    <div class="pagehead"><div><div class="eyebrow">封鎖 / 待審佇列 / C-2416</div>
      <h1>C-2416　短時間輪換手法試探　{chip_ai()} <span class="tag tw">待審</span></h1></div></div>
    <div class="row grow">
      <div class="card grow" style="display:flex;flex-direction:column">
        <h2>連線事實</h2>
        <p class="mu" style="margin:0 0 8px">僅鏡像中繼資料，不解密、不保存封包內容。</p>
        {fact_html}
      </div>
      {analysis}
    </div>'''


def case_detail():
    tr = tree([
        ('封鎖', [('待審佇列', 6), ('C-2416', None), ('已上榜封鎖', 37)]),
        SYS_TREE,
    ], 'C-2416')
    return shell('封鎖與審核', tr, case_body(False), launcher=True)


def ai_chat_case():
    tr = tree([
        ('封鎖', [('待審佇列', 6), ('C-2416', None), ('已上榜封鎖', 37)]),
        SYS_TREE,
    ], 'C-2416')
    return shell('封鎖與審核', tr, case_body(True), launcher=False, panel=chat_panel(), ai_on=True)


def ai_history():
    tr = tree([
        ('監看', ['儀表板']),
        ('封鎖', [('待審佇列', 6)]),
        ('系統', [('告警與健康', None), ('AI 對話紀錄', None)]),
    ], 'AI 對話紀錄')
    rows = [
        ('sel-row', '14:52:08', '王小明', '為何 C-2416 要送待審？', 'C-2416', '4'),
        ('', '14:40:21', '王小明', '今日 AI 引擎狀態與待審件數', '—', '2'),
        ('', '13:18:47', '李大華', '203.0.113.44 為何自動上榜？', 'C-2414', '3'),
        ('', '12:05:03', '王小明', '來源 198.51.100.20 的掃描節奏', 'C-2415', '3'),
        ('', '昨天 17:22', '李大華', '白名單命中會不會進入待審？', '—', '2'),
        ('', '昨天 11:08', '王小明', '2001:db8::40 的固定間隔連線', 'C-2409', '2'),
    ]
    trows = ''.join(
        f'<tr class="{cls}"><td class="mono">{t}</td><td>{u}</td><td>{title}</td>'
        f'<td class="mono">{case}</td><td class="mono">{n}</td></tr>'
        for cls, t, u, title, case, n in rows
    )
    body = f'''
    <div class="pagehead"><div><div class="eyebrow">系統 / 對話</div>
      <h1>{chip_ai()} AI 對話紀錄</h1></div>
      <span class="mu" style="margin-left:auto">所有對話留在本機，並寫入稽核紀錄</span></div>
    <div class="banner bi"><b class="serif" style="font-size:15px">本機 {MODEL}</b>
      <span>對話不會送到外部。{DISCLAIM}</span></div>
    <div class="row grow">
      <div class="card grow" style="display:flex;flex-direction:column;min-height:0;padding:10px 12px">
        <div class="sp-input" style="margin:0 0 8px;color:var(--color-text-muted)">搜尋對話、來源 IP、案件編號…</div>
        <table>
          <colgroup><col style="width:110px"><col style="width:70px"><col><col style="width:80px"><col style="width:48px"></colgroup>
          <tr><th>時間</th><th>使用者</th><th>標題</th><th>關聯案件</th><th>則數</th></tr>
          {trows}
        </table>
      </div>
      <div class="card" style="width:420px;flex:none;display:flex;flex-direction:column;min-height:0;padding:0;overflow:hidden">
        <div class="sp-head">{chip_ai()} <h2 style="margin:0;flex:1">為何 C-2416 要送待審？</h2></div>
        <div class="sp-note">王小明 · <span class="mono">14:52:08</span> · 關聯 <span class="ctx">已帶入案件 C-2416</span>
          <div style="margin-top:6px">使用本機 {MODEL}。對話留在本機，並寫入稽核紀錄。</div></div>
        <div class="msgs">{chat_transcript()}</div>
      </div>
    </div>
    '''
    return shell('', tr, body)

def contrast_rows():
    def L(h):
        h = h.lstrip('#')
        c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
        c = [x / 12.92 if x <= .03928 else ((x + .055) / 1.055) ** 2.4 for x in c]
        return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]

    def cr(a, b):
        x, y = sorted([L(a), L(b)])
        return (y + .05) / (x + .05)

    def mix(fg, bg, p):
        def rgb(h):
            h = h.lstrip('#')
            return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
        f, b = rgb(fg), rgb(bg)
        m = tuple(round(f[i] * p + b[i] * (1 - p)) for i in range(3))
        return '#%02X%02X%02X' % m

    rows = []
    pairs = [
        ('頂欄品牌／時間字 #33291F', T['on_wood'], '橡木淺端 #D2B288', T['wood_from']),
        ('頂欄品牌／時間字 #33291F', T['on_wood'], '橡木深端 #C6A072', T['wood_to']),
        ('頂欄主文字 #2E2A24', T['tx'], '橡木淺端 #D2B288', T['wood_from']),
        ('模式膠囊／AI 入口文字 #2E2A24', T['tx'], '膠囊底 surface #FBF8F2', T['sf']),
        ('頁籤未選 #5F574B', T['mu'], '頁籤列 surface #FBF8F2', T['sf']),
        ('頁籤選中 #2E2A24', T['tx'], '頁籤列 surface #FBF8F2', T['sf']),
        ('樹狀選單文字 #2E2A24', T['tx'], '樹狀底 surface-2 #ECE4D6', T['sf2']),
        ('樹狀選單次要 #5F574B', T['mu'], '樹狀底 surface-2 #ECE4D6', T['sf2']),
        ('樹狀選中項 #2E2A24', T['tx'], '選中底 surface #FBF8F2', T['sf']),
        ('KPI 自動上榜數字 #3F6B4A', T['ok'], 'KPI 淡底（55% sf2） ' + mix(T['sf2'], T['sf'], 0.55), mix(T['sf2'], T['sf'], 0.55)),
        ('KPI 待審數字 #8A5A12', T['war'], 'KPI 淡底（55% sf2） ' + mix(T['sf2'], T['sf'], 0.55), mix(T['sf2'], T['sf'], 0.55)),
        ('KPI 未成案／白名單數字 #3E5F78', T['inf'], 'KPI 淡底（55% sf2） ' + mix(T['sf2'], T['sf'], 0.55), mix(T['sf2'], T['sf'], 0.55)),
        ('狀態燈說明成功 #3F6B4A', T['ok'], '卡片 surface #FBF8F2', T['sf']),
        ('狀態燈說明注意 #8A5A12', T['war'], '卡片 surface #FBF8F2', T['sf']),
        ('狀態燈說明資訊 #3E5F78', T['inf'], '卡片 surface #FBF8F2', T['sf']),
        ('核准／前往核准按鈕字 #FFFFFF', T['pron'], 'primary #4F6B57', T['pr']),
        ('駁回／撤回按鈕 #9E3B2C', T['dan'], '卡片 surface #FBF8F2', T['sf']),
        ('登入主標 #2E2A24', T['tx'], '頁底 #F4EFE6', T['bg']),
        ('登入木板標語 #2E2A24', T['tx'], '橡木淺端 #D2B288', T['wood_from']),
        ('登入木板次行 #33291F', T['on_wood'], '橡木深端 #C6A072', T['wood_to']),
        ('登入木板次行 #33291F', T['on_wood'], '橡木深端＋木紋條 #BD986B', '#BD986B'),
        ('AI 徽章字 #FFFFFF', '#FFFFFF', 'AI 徽章底 info #3E5F78', T['inf']),
        ('規則徽章字 #FFFFFF', '#FFFFFF', '規則徽章底 neutral #6B6358', T['neu']),
        ('詢問 AI 啟動器字 #FFFFFF', '#FFFFFF', '啟動器底 info #3E5F78', T['inf']),
        ('AI 理由／次要說明 #5F574B', T['mu'], '卡片 surface #FBF8F2', T['sf']),
        ('已帶入案件晶片 #3E5F78', T['inf'], 'info 10% 淡底 ' + mix(T['inf'], T['sf'], 0.10), mix(T['inf'], T['sf'], 0.10)),
        ('使用者對話字 #2E2A24', T['tx'], '氣泡 surface-2 #ECE4D6', T['sf2']),
        ('AI 對話字 #2E2A24', T['tx'], '氣泡 info 7% 淡底 ' + mix(T['inf'], T['sf'], 0.07), mix(T['inf'], T['sf'], 0.07)),
        ('側欄說明 #5F574B', T['mu'], 'info 7% 淡底 ' + mix(T['inf'], T['sf'], 0.07), mix(T['inf'], T['sf'], 0.07)),
        ('信心數字 warning #8A5A12', T['war'], '卡片 surface #FBF8F2', T['sf']),
        ('選中對話列字 #2E2A24', T['tx'], 'info 8% 淡底 ' + mix(T['inf'], T['sf'], 0.08), mix(T['inf'], T['sf'], 0.08)),
    ]
    for label, fg, p, name in [
        ('模式橫幅 info #3E5F78', T['inf'], 0.07, 'info 7% 淡底'),
        ('待審橫幅 warning #8A5A12', T['war'], 0.08, 'warning 8% 淡底'),
        ('健康注意標題 #8A5A12', T['war'], 0.08, 'warning 8% 淡底'),
    ]:
        bg = mix(fg, T['sf'], p)
        pairs.append((label, fg, f'{name} {bg}', bg))
    for label, fg, p in [
        ('高風險標籤 #9E3B2C', T['dan'], 0.10),
        ('注意標籤 #8A5A12', T['war'], 0.12),
        ('成功標籤 #3F6B4A', T['ok'], 0.12),
        ('資訊標籤 #3E5F78', T['inf'], 0.10),
    ]:
        bg = mix(fg, T['sf'], p)
        pairs.append((label, fg, f'{int(p*100)}% 淡底 {bg}', bg))
    for label, fg, bg, bn in [
        ('狀態燈成功（圖形） #3F6B4A', T['ok'], T['sf'], '卡片 #FBF8F2'),
        ('狀態燈注意（圖形） #8A5A12', T['war'], T['sf'], '卡片 #FBF8F2'),
        ('頂欄模式燈成功（圖形） #3F6B4A', T['ok'], T['sf'], '模式膠囊 #FBF8F2'),
    ]:
        pairs.append((label, fg, bn, bg))

    lowest, lowest_name = 99, ''
    for name, fg, bgname, bg in pairs:
        r = cr(fg, bg)
        ok = '✓' if r >= 4.5 else '✗'
        rows.append(f'| D（nordic） | {name} | {bgname} | {r:.2f}:1 | {ok} |')
        if r < lowest:
            lowest, lowest_name = r, f'{name} on {bgname}'
    return rows, lowest, lowest_name


def render(html_path, png_path):
    cmd = [
        'google-chrome',
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        '--window-size=1440,900',
        f'--screenshot={png_path}',
        f'file://{html_path}',
    ]
    subprocess.check_call(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)


def main():
    pages = {
        'console-dashboard': dashboard(),
        'console-blocklist-review': blocklist(),
        'console-alerts-health': alerts(),
        'console-login': login(),
        'console-case-detail': case_detail(),
        'console-ai-chat-case': ai_chat_case(),
        'console-ai-history': ai_history(),
    }
    for name, html in pages.items():
        html_path = os.path.join(HERE, f'{name}.html')
        png_path = os.path.join(HERE, f'{name}.png')
        with open(html_path, 'w', encoding='utf-8') as f:
            f.write(html)
        render(html_path, png_path)
        print('wrote', png_path)

    rows, lowest, lowest_name = contrast_rows()
    section = [
        '',
        '### 管理主控台（2026-11-17，僅 D 北歐溫潤）',
        '',
        '沿用 v1.0 tokens。頂欄與登入木板只用 `--color-on-wood` / `--color-text`。數字與 IP 使用 Noto Sans Mono + `zero` 斜線 0。',
        '新增 AI／規則徽章：AI 為實心 info `#3E5F78`＋白字與四向星標；規則為實心 neutral `#6B6358`＋白字。本機模型名稱全稿為 Llama 3.1 8B（僅作示意，非廠商介面）。',
        '',
        '| 方向 | 前景 | 背景 | 對比 | AA |',
        '|---|---|---|---|---|',
        *rows,
        '',
        f'本批最低文字對比：**{lowest:.2f}:1**（{lowest_name}）。',
        '',
    ]
    contrast_path = os.path.join(HERE, 'contrast.md')
    existing = open(contrast_path, encoding='utf-8').read()
    marker = '### 管理主控台（2026-11-17，僅 D 北歐溫潤）'
    if marker in existing:
        existing = existing.split(marker)[0].rstrip() + '\n'
    with open(contrast_path, 'w', encoding='utf-8') as f:
        f.write(existing + '\n'.join(section))
    print(f'lowest contrast {lowest:.2f}:1 ({lowest_name})')


if __name__ == '__main__':
    main()
