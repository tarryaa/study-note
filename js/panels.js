// 設定・使い方・ようこそ画面
import { h } from './util.js';
import { icon } from './icons.js';
import { settings, saveSettings, ACCENTS, resetSettings } from './settings.js';
import * as ui from './ui.js';
import * as store from './store.js';
import { LOGO } from './library.js';

export const VERSION = '1.0.0';

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
      '手書き',
      ui.row('予測描画', ui.toggle(settings.prediction, set('prediction')), 'ペン先の少し先まで線を描いて、遅れを感じにくくします'),
      ui.row('指で描く', ui.segmented([{ value: 'auto', label: '自動' }, { value: 'on', label: 'オン' }, { value: 'off', label: 'オフ' }], settings.fingerDraw, (v) => { set('fingerDraw')(v); app.editor.updateFinger(); }), '自動：Apple Pencil を使うと、指はスクロールとズーム専用になります'),
      ui.row('ぐしゃぐしゃ書きで消す', ui.toggle(settings.scribble, set('scribble')), 'ペンで塗りつぶすように往復すると、その下の線が消えます'),
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
  ['sparkle', 'ぐしゃぐしゃっと消す', 'ペンのまま、消したい所を塗りつぶすように往復すると線が消えます'],
  ['shapes', '止めると図形に', '線・円・四角・三角を描いてペンを止めると、きれいな図形に補正。直線は止めた後も向きを調整できます'],
  ['undo', '2 本指タップで元に戻す', '3 本指タップでやり直し。⌘Z / ⇧⌘Z も使えます'],
  ['zoom', 'ピンチでズーム', '2 本指でズーム・移動。指でダブルタップすると拡大／戻す'],
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
