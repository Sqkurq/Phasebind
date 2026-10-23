// Phasebind UI strings. The language is a panel setting and never follows
// Ae's or the OS locale. Codes from ExtendScript / Live map to err.* / warn.*.
(function (root) {
  "use strict";

  var STRINGS = {
    ja: {
      send: "選択レイヤーを Live へ",
      get: "Live のミックスを Ae へ",
      settings: "設定",
      close: "閉じる",
      saveTo: "保存先",
      fixedDir: "固定",
      chooseFolder: "フォルダを選択",
      hintFixed: "./ は .aep の場所",
      hintAsk: "毎回選択",
      exportMode: "書き出し",
      exportAuto: "WAV は切り出し",
      exportRender: "常にレンダー",
      muteSent: "送ったレイヤーをミュート",
      tail: "テール",
      silenceDb: "無音 dB",
      holdMs: "保持 ms",
      maxSec: "最大 秒",
      trimDb: "トリム dB",
      offsetMs: "補正 ms",
      language: "言語",

      connOff: "Live 未接続",
      connOn: "Live {0} BPM · v{1}",
      putOnMaster: "Master に挿す",
      preview: "プレビュー",
      rendering: "レンダー: {0}",
      sent: "Live へ {0} 件",
      capturing: "収録中",
      added: "追加",
      replaced: "差し替え",
      imported: "{0} · {1}s + テール {2}s · {3} dBFS",
      muted: "{0} 件ミュート",
      pickAsk: "保存先を選択",
      pickBase: "未保存のプロジェクト：基準フォルダを選択",

      "err.noComp": "コンポを開いてください",
      "err.noAudioLayer": "音声レイヤーを選択してください",
      "err.outsideComp": "レイヤーがコンポの範囲外です",
      "err.wavOutput": "音声を書き出せません。出力モジュールテンプレート「AIFF 48kHz」があるか確認してください",
      "err.renderFailed": "レンダーに失敗しました",
      "err.cancelled": "キャンセルしました",
      "err.noLive": "Live 未接続",
      "err.connectionLost": "Live との接続が切れました",
      "err.busy": "収録中です",
      "err.notOnMaster": "デバイスを Master に挿してください",
      "err.noClips": "アレンジメントにクリップがありません",
      "err.stopped": "再生が止まったため中断しました",
      "err.noStart": "再生が始まりません",
      "err.lateStart": "再生位置がずれました。もう一度実行してください",
      "err.postFailed": "音声の処理に失敗しました",
      "err.importFailed": "Live への配置に失敗しました",
      "err.badRequest": "通信エラー",
      "err.liveError": "Live エラー",
      "err.host": "Ae エラー",
      "warn.markerMissing": "位置は概算",
      "warn.approxAlign": "位置は概算",
      "warn.tailCut": "テールが切れた可能性"
    },
    en: {
      send: "Send selected layers to Live",
      get: "Bring the Live mix into Ae",
      settings: "Settings",
      close: "Close",
      saveTo: "Save to",
      fixedDir: "Fixed",
      chooseFolder: "Choose folder",
      hintFixed: "./ is relative to the .aep",
      hintAsk: "Ask every time",
      exportMode: "Export",
      exportAuto: "Trim WAV sources",
      exportRender: "Always render",
      muteSent: "Mute sent layers",
      tail: "Tail",
      silenceDb: "Silence dB",
      holdMs: "Hold ms",
      maxSec: "Max s",
      trimDb: "Trim dB",
      offsetMs: "Offset ms",
      language: "Language",

      connOff: "Live offline",
      connOn: "Live {0} BPM · v{1}",
      putOnMaster: "Put on Master",
      preview: "Preview",
      rendering: "Rendering {0}",
      sent: "Sent {0} to Live",
      capturing: "Capturing",
      added: "Added",
      replaced: "Replaced",
      imported: "{0} · {1}s + {2}s tail · {3} dBFS",
      muted: "{0} muted",
      pickAsk: "Choose a save folder",
      pickBase: "Unsaved project: choose a base folder",

      "err.noComp": "Open a composition",
      "err.noAudioLayer": "Select a layer with audio",
      "err.outsideComp": "Layer is outside the composition",
      "err.wavOutput": "Can't render audio. Check that the \"AIFF 48kHz\" output module template exists",
      "err.renderFailed": "Render failed",
      "err.cancelled": "Canceled",
      "err.noLive": "Live offline",
      "err.connectionLost": "Lost connection to Live",
      "err.busy": "Already capturing",
      "err.notOnMaster": "Put the device on Master",
      "err.noClips": "No clips in the arrangement",
      "err.stopped": "Stopped: playback ended early",
      "err.noStart": "Playback didn't start",
      "err.lateStart": "Playback started late. Try again",
      "err.postFailed": "Audio processing failed",
      "err.importFailed": "Couldn't place audio in Live",
      "err.badRequest": "Connection error",
      "err.liveError": "Live error",
      "err.host": "Ae error",
      "warn.markerMissing": "Approximate alignment",
      "warn.approxAlign": "Approximate alignment",
      "warn.tailCut": "Tail may be cut"
    }
  };

  var lang = "ja";

  function t(key) {
    var table = STRINGS[lang] || STRINGS.ja;
    var s = table.hasOwnProperty(key) ? table[key] : (STRINGS.ja[key] || key);
    for (var i = 1; i < arguments.length; i++) s = s.split("{" + (i - 1) + "}").join(String(arguments[i]));
    return s;
  }

  function has(key) {
    return STRINGS.ja.hasOwnProperty(key);
  }

  // data-i18n: text, data-i18n-title: title + aria-label.
  function apply(doc) {
    doc.documentElement.lang = lang;
    var nodes = doc.querySelectorAll("[data-i18n]");
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = t(nodes[i].getAttribute("data-i18n"));
    nodes = doc.querySelectorAll("[data-i18n-title]");
    for (var j = 0; j < nodes.length; j++) {
      var label = t(nodes[j].getAttribute("data-i18n-title"));
      nodes[j].title = label;
      nodes[j].setAttribute("aria-label", label);
    }
  }

  root.PLi18n = {
    t: t,
    has: has,
    apply: apply,
    setLang: function (l) { lang = STRINGS[l] ? l : "ja"; },
    getLang: function () { return lang; }
  };
}(window));
