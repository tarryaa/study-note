// 設定・使い方・ようこそ画面
import { h } from './util.js';
import { icon } from './icons.js';
import { settings, saveSettings, ACCENTS, resetSettings } from './settings.js';
import * as ui from './ui.js';
import * as store from './store.js';
import { LOGO } from './library.js';

export const VERSION = '1.3.0';

function fmtBytes(b) {
  if (!b && b !== 0) return '-';
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
  return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

export function openSettings(app) {
  const accent = h('div', { class: 'swatches accent' });
  for (const [k, c] of Object.entries(ACCENTS)) {
    const b = h('button', { class: 'swatch' + (settings.accent === k ? ' on' : ''), 'aria-label': k });
    b.style.setProperty('--c', c);
    b.addEventListener('click', () => {
      settings.accent = k;
      saveSettings();
      for (const x of accent.children) x.classList.toggle('on', x === b);
    });
    accent.append(b);
  }
  const set = (k) => (v) => {
    settings[k] = v;
    saveSettings();
  };
  const storageVal = h('span', { class: 'muted', text: '計算中…' });
  const persistVal = h('span', { class: 'muted', text: '' });
  if (navigator.storage && navigator.storage.estimate) {
    navigator.storage.estimate().then((e) => {
      storageVal.textContent = `${fmtBytes(e.usage)} 使用中`;
    }).catch(() => (storageVal.textContent = '-'));
  } else storageVal.textContent = '-';
  if (navigator.storage && navigator.storage.persisted) {
    navigator.storage.persisted().then((p) => (persistVal.textContent = p ? '保護されています' : '標準')).catch(() => {});
  }
  const btn = (label, fn, cls = '') => {
    const b = h('button', { class: 'btn sm ' + cls, text: label });
    b.addEventListener('click', fn);
    return b;
  };
  const body = h(
    'div',
    { class: 'settings' },
    ui.section(
      '外観',
      ui.row('テーマ', ui.segmented([{ value: 'system', label: '自動' }, { value: 'light', label: 'ライト' }, { value: 'dark', label: 'ダーク' }], settings.theme, set('theme'))),
      ui.row('アクセントカラー', accent),
      ui.row('ツールバーの位置', ui.segmented([{ value: 'top', label: '上' }, { value: 'bottom', label: '下' }, { value: 'left', label: '左' }, { value: 'right', label: '右' }], settings.dockPos, (v) => app.editor.setDockPos(v, false)), 'エディタでつまみをドラッグしても変えられます')
    ),
    ui.section(
      'ズーム',
      ui.row('縮小したときの余白（上・左右）', ui.slider({ min: 0.3, max: 2.5, step: 0.05, value: settings.zoomMargin, format: (v) => v.toFixed(2) + '×', onInput: (v) => { settings.zoomMargin = v; saveSettings(); app.editor.engine.settleView(); } }), 'いちばん縮小したとき、ページのまわりに空ける幅（ツールバーの高さの何倍か）'),
      ui.row('縮小したときの余白（下）', ui.slider({ min: 0.2, max: 2.5, step: 0.05, value: settings.zoomMarginBottom, format: (v) => v.toFixed(2) + '×', onInput: (v) => { settings.zoomMarginBottom = v; saveSettings(); app.editor.engine.settleView(); } }))
    ),
    ui.section(
      '手書き',
      ui.row('予測描画', ui.toggle(settings.prediction, set('prediction')), 'ペン先の少し先まで線を描いて、遅れを感じにくくします'),
      ui.row('指で描く', ui.segmented([{ value: 'auto', label: '自動' }, { value: 'on', label: 'オン' }, { value: 'off', label: 'オフ' }], settings.fingerDraw, (v) => { set('fingerDraw')(v); app.editor.updateFinger(); }), '自動：Apple Pencil を使うと、指はスクロールとズーム専用になります'),
      ui.row('ぐしゃぐしゃ書きで消す', ui.toggle(settings.scribble, set('scribble')), '一筆で何度も往復（ジグザグ・ぐるぐる）すると、その下の線が消えます。普通の字では反応しません'),
      ui.row('消すときの感度', ui.segmented([{ value: 0, label: '控えめ' }, { value: 1, label: 'ふつう' }, { value: 2, label: '敏感' }], settings.scribbleSens, set('scribbleSens'))),
      ui.row('止めると図形に補正', ui.toggle(settings.holdShape, set('holdShape')), '線を描いたままペンを止めると、直線・円・四角などに整えます'),
      ui.row('2本指タップで元に戻す', ui.toggle(settings.twoFingerUndo, set('twoFingerUndo')), '3本指タップでやり直し'),
      ui.row('消しゴムの後ペンに戻る', ui.toggle(settings.autoRevert, set('autoRevert')))
    ),
    ui.section(
      'データ',
      ui.row('保存容量', storageVal, 'ノートはこの端末の中だけに保存されます'),
      ui.row('保存データの保護', persistVal),
      ui.row('バックアップを書き出す', btn('書き出す', () => app.exportAll()), 'すべてのフォルダとノートを 1 つのファイルにまとめます'),
      ui.row('バックアップから復元', btn('読み込む', () => app.pickBackup())),
      ui.row('ゴミ箱を空にする', btn('空にする', () => app.library.deleteForever(store.state.notes.filter((n) => n.deletedAt).map((n) => n.id)), 'danger'))
    ),
    ui.section(
      'このアプリについて',
      ui.row('バージョン', h('span', { class: 'muted', text: VERSION })),
      ui.row('使い方', btn('表示', () => openHelp())),
      ui.row('設定をリセット', btn('リセット', async () => {
        const ok = await ui.confirmDialog({ title: '設定をリセットしますか？', message: 'ペンの色や太さ、表示の設定が初期状態に戻ります（ノートは消えません）。', ok: 'リセット', danger: true });
        if (ok) {
          resetSettings();
          location.reload();
        }
      }, 'danger'))
    )
  );
  ui.sheet({ title: '設定', body, className: 'wide settings-sheet' });
}

const GESTURES = [
  ['pen', 'Apple Pencil で書く', '筆圧で太さが変わります。指はスクロール・ズーム用（ヘッダーの手のボタンで切替）'],
  ['sparkle', 'ぐしゃぐしゃっと消す', 'ペンを離さず一筆で、消したい所を何度も往復（ジグザグ・ぐるぐる）すると線が消えます。消した直後は「元に戻す」で戻せます。下を通る長い線は覆った部分だけ消えます。反応しすぎる／しにくいときは設定の「消すときの感度」で調整'],
  ['shapes', '止めると図形に', '直線・弧・曲線・折れ線・円・四角・三角を描いてペンを止めると整います。そのまま動かすと大きさや向きを調整できます'],
  ['shapes', '図形ツール', 'ツールバーの図形から、矢印・星・多角形などをドラッグで描けます。塗りや縦横比固定も選べます'],
  ['pages', 'ページは横に並ぶ', '左右にスワイプでページ移動。最後のページでさらに左へ引っ張ると新しいページが追加されます'],
  ['stamp', 'スタンプ', 'なげなわで囲んで「スタンプ」で保存。スタンプツールでタップするとすぐに貼れます'],
  ['template', '罫線・方眼の間隔', 'ページの設定（ノート作成時も）で、横罫・方眼・ドットの間隔を 2〜15mm の間で 0.5mm 単位で選べます'],
  ['img-page', '画像からページ', 'ページ追加やノート作成で「画像から」を選ぶと、写真やプリントをそのままページにできます'],
  ['undo', '2 本指タップで元に戻す', '3 本指タップでやり直し。⌘Z / ⇧⌘Z も使えます'],
  ['zoom', 'ピンチでズーム', '縮小はページ全体が見えるところまで。指を離すとページの見やすい位置に自動で戻ります'],
  ['lasso', 'なげなわで編集', '囲んで移動・拡大縮小・回転・色変更・コピー。他のページへのドラッグもOK'],
  ['folder-move', '長押しでドラッグ整理', 'ノートやフォルダを長押しして、サイドバーのフォルダへドラッグ'],
  ['dock', 'ツールバーは自由に移動', 'つまみ（⋮⋮）をドラッグして上下左右に配置。ツールを再タップで詳細設定'],
  ['database', 'バックアップを忘れずに', 'データはこの iPad の中だけに保存されます。設定 → バックアップで書き出せます'],
];

export function openHelp() {
  const list = h('div', { class: 'help-list' });
  GESTURES.forEach(([ic, t, d], i) => {
    const el = h('div', { class: 'help-item' }, h('span', { class: 'help-ic', html: icon(ic) }), h('div', {}, h('b', { text: t }), h('p', { text: d })));
    el.style.setProperty('--i', i);
    list.append(el);
  });
  ui.sheet({ title: '使い方', body: list, className: 'wide' });
}

export function maybeWelcome() {
  if (settings.welcomed) return;
  const feats = [
    ['pen', '遅延を抑えた手書き', '筆圧・予測描画対応'],
    ['sparkle', 'ぐしゃぐしゃで消去', '持ち替え不要'],
    ['folder', 'フォルダで整理', 'ドラッグで移動'],
    ['shapes', '図形を自動補正', '止めるだけ'],
  ];
  const go = h('button', { class: 'btn primary block lg', text: 'はじめる' });
  const body = h(
    'div',
    { class: 'welcome' },
    h('div', { class: 'wl-logo', html: LOGO }),
    h('h2', { text: '勉強ノートへようこそ' }),
    h('p', { class: 'muted', text: 'iPad と Apple Pencil のための、軽くて自由な手書きノート。' }),
    h('div', { class: 'wl-feats' }, ...feats.map(([ic, t, d], i) => {
      const el = h('div', { class: 'wl-feat' }, h('span', { class: 'help-ic', html: icon(ic) }), h('b', { text: t }), h('small', { text: d }));
      el.style.setProperty('--i', i);
      return el;
    })),
    isIOSBrowser() ? h('p', { class: 'wl-tip', html: `${icon('share')}<span>Safari の共有ボタン →「ホーム画面に追加」で、アプリとして全画面で使えます</span>` }) : null,
    go
  );
  const s = ui.sheet({ title: '', body, className: 'welcome-sheet', onClose: () => { settings.welcomed = true; saveSettings(); } });
  go.addEventListener('click', () => s.close());
}

export function isIOSBrowser() {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  return ios && !standalone;
}
