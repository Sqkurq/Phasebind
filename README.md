# Phasebind

After Effects と Ableton Live のあいだで音を往復させるツールです。

- **Ae → Live**：選択したレイヤーの音を、Live の同じ時間位置に新しいトラックとして置きます
- **Live → Ae**：Live のミックス（Master）を余韻まで収録し、Ae のコンポ先頭に置きます。2 回目からは同じレイヤーを差し替えます

[English](#english)

## 動作環境

- Windows 10 / 11
- After Effects 2025 以降
- Ableton Live 12 Suite（または Standard + Max for Live）

## インストール

配布ファイル：

- `Phasebind-<version>-win.zxp`（After Effects 用）
- `Phasebind-<version>-ableton` フォルダ（Live 用）

### After Effects（ZXP インストーラーを推奨）

1. After Effects を終了します
2. ZXP インストーラー（例：aescripts の無料ツール「ZXP/UXP Installer」）を起動し、`Phasebind-<version>-win.zxp` をウィンドウにドラッグします
3. After Effects を起動し、**ウィンドウ > エクステンション > Phasebind** を開きます

インストーラーを使わない場合は、Creative Cloud 付属のインストーラーをコマンドプロンプトから実行します。

```
"C:\Program Files\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe" /install "<ダウンロード先>\Phasebind-<version>-win.zxp"
```

### Ableton Live（Max for Live デバイスとして）

1. `Phasebind-<version>-ableton` フォルダを、Live の User Library の Max Audio Effect フォルダにコピーします

   ```
   <User Library>\Presets\Audio Effects\Max Audio Effect\Phasebind\
   ```

   - User Library の場所は Live の **設定 > Library** で確認できます（既定は `ドキュメント\Ableton\User Library`）
   - フォルダの中身（`Phasebind.amxd` と `.js` ファイル）はまとめたままにしてください。`.amxd` だけを動かすと読み込めません
2. Live のブラウザで **User Library > Presets > Audio Effects > Max Audio Effect > Phasebind** を開きます
3. `Phasebind.amxd` を **Master トラック**にドラッグします。デバイスチェーンの最後がおすすめです
4. デバイスに `Ready` と表示されれば準備完了です

一度 Master に挿した状態でセットを保存するか、デフォルトのセット（**設定 > File & Folder > Save Current Set as Default**）に入れておくと、毎回挿す手間が省けます。

Ae パネル左上のランプが白く点けば接続できています。

| ランプ | 状態 |
|---|---|
| ○ 中抜き | Live 未接続（デバイスが読み込まれていない） |
| ● 白 | 接続中 |
| ● ピンク | デバイスが Master 以外に挿さっている |

## 使い方

### Ae → Live（レイヤー＋上矢印のボタン）

1. Ae で音声を含むレイヤーを選びます
2. ボタンを押すと、WAV に書き出して Live に新しいトラックとして置きます
   - 元が WAV で伸縮・タイムリマップがなければ、そのまま切り出します（エフェクトは反映されません）
   - それ以外はレンダーします（エフェクト・レベルを反映）

### Live → Ae（ピンクの下矢印ボタン）

1. ボタンを押すと、Live が自動で再生され、Master の音をリアルタイムで収録します
   - Live のループが**オン**ならループ範囲、**オフ**ならアレンジメント全体を収録します
2. 範囲の後も、リバーブやディレイの余韻が消えるまで収録を続けます
3. 終わると Ae のコンポ先頭に「Live Mix」レイヤーとして置きます。2 回目からは同じレイヤーを差し替えます

Live のデバイスの **Send to Ae** からも同じ収録ができます。

収録中は Live の再生位置・ループ・クリップのミュートを一時的に変更し、終わると元に戻します。

## 設定（パネル右上の歯車）

| 項目 | 内容 |
|---|---|
| 保存先 | 既定は `./Phasebind`（.aep と同じフォルダ）。「固定」をオフにすると毎回選びます。未保存のプロジェクトでは最初に基準フォルダを聞きます |
| 書き出し | Ae → Live の書き出し方法（WAV は切り出し / 常にレンダー） |
| 送ったレイヤーをミュート | Live から取り込んだとき、Live に送ったレイヤーの音をオフにして二重に鳴らないようにします |
| テール | 余韻の判定（無音 dB・保持 ms・最大 秒）、末尾の無音カット（トリム dB）、位置の微調整（補正 ms） |
| 言語 | 日本語 / English（Ae の言語設定とは独立） |

## 書き出し用プリセット「Phasebind WAV」（任意）

Ae → Live のレンダーは、プリセットがなくても自動で行います（WAV を設定できない環境では Ae 付属の「AIFF 48kHz」で書き出し、WAV に変換します）。書き出し設定を自分で決めたい場合は、次のプリセットを作ると最優先で使われます。

1. **編集 > テンプレート > 出力モジュール...** を開きます
2. **新規** を押し、設定名を `Phasebind WAV` にします（名前は完全に一致させてください）
3. **編集...** を押し、次のように設定して OK します
   - 形式：**WAV**
   - オーディオ出力：**オン**、48.000 kHz、24 bit、ステレオ（必要に応じて変更可）
4. OK でダイアログを閉じます

## 注意

- 収録は**リアルタイム**です。曲の長さぶん時間がかかります（Live には外部から書き出しを実行する仕組みがないため）
- Master のデバイスはフェーダーより前で鳴るため、**Master フェーダーの音量は収録に含まれません**（Master のエフェクトは含まれます）
- テンポが途中で変わる曲には対応していません
- Live と Ae は同じ PC で動かしてください（127.0.0.1 の TCP ポート 47820 を使います）

## 困ったとき

| 症状 | 対処 |
|---|---|
| ランプが点かない | Live の Master に Phasebind デバイスがあるか確認。Max のウィンドウにエラーが出ていないか確認 |
| 「音声を書き出せません」 | 「Phasebind WAV」プリセットを作る（上記）か、下の手順で「AIFF 48kHz」を追加し直す |
| ランプは白いが Live にトラックが増えない | Max のウィンドウにエラーが出ていないか確認。デバイスのフォルダ内のファイルが揃っているか確認 |

**「AIFF 48kHz」プリセットを手動で追加する**（Ae 付属のものを削除・改名した場合）

1. **編集 > テンプレート > 出力モジュール...** を開きます
2. **新規** を押し、設定名を `AIFF 48kHz` にします（名前に「AIFF」が含まれていれば認識します）
3. **編集...** を押し、形式：**AIFF**、オーディオ出力：**オン**、48.000 kHz、16 bit、ステレオにして OK します
4. OK でダイアログを閉じます
| 「再生位置がずれました」 | もう一度実行 |
| 余韻が途中で切れる | 設定の「最大 秒」を増やす |
| 頭がわずかにずれる | 設定の「補正 ms」で調整 |

## ソースからビルド

Windows、Node.js が必要です。`npm run build` で `dist/` に ZXP と Live 用デバイスを出力します（初回に署名ツールの取得と自己署名証明書の作成を行います）。

## ライセンス

Copyright (C) 2026 Sqkurq

[GNU General Public License v3.0 以降](LICENSE)（GPL-3.0-or-later）で公開しています。商用を含めて自由に使え、改変・再配布もできます。改変したものを配布する場合は、同じ GPL でソースコードを公開してください。作った音声・映像は自由に使えます（GPL の対象外です）。

同梱のフォント（Mona Sans、Noto Sans JP：SIL OFL 1.1）とアイコン（Material Symbols：Apache 2.0）は、それぞれのライセンスに従います（拡張機能内の `assets/fonts`）。

After Effects は Adobe の、Ableton Live は Ableton AG の商標です。Phasebind は Adobe・Ableton・Cycling '74 とは関係ありません。

---

## English

Phasebind moves audio between After Effects and Ableton Live.

- **Ae → Live**: sends selected layers to Live as new tracks at the same time position
- **Live → Ae**: records the Live mix (Master), including reverb and delay tails, and places it at the start of the comp. Later captures replace the same layer

### Requirements

Windows 10 / 11, After Effects 2025 or later, Ableton Live 12 Suite (or Standard with Max for Live).

### Install

**After Effects (a ZXP installer is recommended)**: quit Ae, open a ZXP installer (for example aescripts' free "ZXP/UXP Installer"), and drag `Phasebind-<version>-win.zxp` onto it. Then open **Window > Extensions > Phasebind**.

Without an installer, run Creative Cloud's bundled installer:

```
"C:\Program Files\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe" /install "<path>\Phasebind-<version>-win.zxp"
```

**Ableton Live (as a Max for Live device)**:

1. Copy the `Phasebind-<version>-ableton` folder to `<User Library>\Presets\Audio Effects\Max Audio Effect\Phasebind\` (find the User Library under **Settings > Library**; default `Documents\Ableton\User Library`). Keep the `.amxd` and `.js` files together.
2. In Live's browser, open **User Library > Presets > Audio Effects > Max Audio Effect > Phasebind**.
3. Drag `Phasebind.amxd` onto the **Master** track. The device shows `Ready` when it is loaded.

Save it in your default set (**Settings > File & Folder > Save Current Set as Default**) to have it on Master every time.

The lamp at the top left of the Ae panel turns white when connected (pink: device is not on Master).

### "Phasebind WAV" preset (optional)

Ae → Live renders work without a preset (if WAV can't be set, Phasebind renders with Ae's bundled "AIFF 48kHz" template and converts to WAV). To choose the settings yourself, create a preset; Phasebind uses it first:

1. **Edit > Templates > Output Module...**
2. **New**, name it exactly `Phasebind WAV`
3. **Edit...**: Format **WAV**, Audio Output **On**, 48.000 kHz, 24 bit, Stereo
4. Close with OK

### Troubleshooting

- **"Can't render audio"**: create the `Phasebind WAV` preset above, or re-add **AIFF 48kHz**: **Edit > Templates > Output Module...** > **New**, name `AIFF 48kHz` (any name containing "AIFF" works), **Edit...**: Format **AIFF**, Audio Output **On**, 48.000 kHz, 16 bit, Stereo.
- **Lamp stays off**: check that the device is on Master and the Max window shows no errors.

### Use

- **Layers + up arrow**: export the selected audio layers and place them in Live
- **Pink down arrow**: capture the Live mix in real time and bring it into Ae. Loop on: loop region. Loop off: whole arrangement. Recording continues until the tail decays
- **Send to Ae** on the Live device does the same capture from Live

Settings (gear icon): save folder (default `./Phasebind`, next to the .aep; turn off **Fixed** to choose each time), export mode, mute sent layers, tail detection, language.

### Notes

- Capture runs in real time; Live has no external export command
- The Master fader level is not included (Master effects are)
- Tempo changes within a song are not supported
- Live and Ae must run on the same computer (TCP 127.0.0.1:47820)

### Build from source

Requires Windows and Node.js. `npm run build` writes the ZXP and the Live device to `dist/` (the first run downloads Adobe's signing tool and creates a self-signed certificate).

### License

Copyright (C) 2026 Sqkurq. Licensed under the [GNU General Public License v3.0 or later](LICENSE) (GPL-3.0-or-later). You may use, modify, and redistribute it, including commercially; modified versions you distribute must also be released under the GPL with source. Audio and video you create with it are yours and not covered by the GPL.

Bundled fonts (Mona Sans, Noto Sans JP: SIL OFL 1.1) and icons (Material Symbols: Apache 2.0) keep their own licenses (`assets/fonts` in the extension).

After Effects is a trademark of Adobe. Ableton Live is a trademark of Ableton AG. Phasebind is not affiliated with Adobe, Ableton, or Cycling '74.
