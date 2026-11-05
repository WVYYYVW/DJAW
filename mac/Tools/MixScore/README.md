# MixScore — 自動ミックスの採点キット（参考用）

DJAW のおまかせミックスを、**参照ミックス**（プロの DJ ミックスの音源、または手で作ったミックス）と比べて点数を出します。

> **あくまで参考値です。** プロ同士でも、同じ 2 曲のつなぎ位置が一致するのは 4 拍以内で約 4 割です（Kim et al., ISMIR 2020）。
> 点が低くても悪いつなぎとは限りません。傾向をつかむために使ってください。

## 必要なもの
Python 3 と `numpy scipy librosa soundfile`（`pip install numpy scipy librosa soundfile`）。

## 使い方

### A. プロのミックス音源と比べる
1. ミックス音源と、その中で使われている曲のファイルを用意します（曲は1つのフォルダにまとめると楽です）。
2. 参照プランを取り出します（ミックスと各曲を照合し、つなぎ位置・長さ・低音の入れ替え・テンポを推定）:
   ```
   python mixscore.py extract --mix pro_mix.wav --tracks 曲フォルダ --out ref.json
   ```
   ミックスに入っていない曲は自動で除外されます。
3. 同じ曲順で DJAW に自動ミックスさせます。
   - Debug ビルドなら、スクリプトを書き出して DJAW を起動するだけです:
     ```
     python mixscore.py script --ref ref.json --out ~/Downloads/DJAW_DEBUG_SCRIPT.txt --report ~/Downloads/candidate.json
     ```
   - 手作業でも可: 同じ順に曲を並べて「おまかせミックス」→ 音声を含めずに `.djaw` で保存。
4. 採点します:
   ```
   python mixscore.py score --ref ref.json --cand candidate.json   (または candidate.djaw)
   ```

### B. 手で作ったミックス（.djaw）と比べる
自分で作ったミックス（音声を含めずに保存した `.djaw`）をそのまま参照にできます。
```
python mixscore.py score --ref 手作業.djaw --cand おまかせ.djaw
```

## C. 設定の自動調整（tune）
参照ミックス（`extract` で作った ref.json）が手元にあるとき、おまかせミックスの設定（重ねる長さの好み・カットの出やすさ・ドロップ着地の重み・歌の重なりの避け方など）を少しずつ変えて採点し、点が上がった変更だけを残します。
```
python mixscore.py tune-prepare --refs ref1.json ref2.json --work ~/Downloads/DJAW_tune \
       --mac-tracks ~/Downloads/曲フォルダ
# → ~/Downloads/DJAW_tune/DJAW_DEBUG_SCRIPT.txt を ~/Downloads に置いて DJAW（Debug ビルド）を起動
python mixscore.py tune-collect --refs ref1.json ref2.json --work ~/Downloads/DJAW_tune --out MixTuning.json
```
できた `MixTuning.json` を `~/Library/Application Support/DJAW/MixTuning.json` に置くと、DJAW がその設定を使います（消せば元の設定）。

## D. EQ・フェーダーの動かし方を学習（learn-shapes）
参照ミックスのブレンドから「低音を入れ替える速さ」「中音・高音を入れ替えるタイミング」「次の曲の音量が上がりきる位置」などを取り出し、ジャンル別にまとめます。
```
python mixscore.py learn-shapes --refs ref1.json ref2.json --out MixTuning.json [--genres DJAWのレポート.json] [--base 既存のMixTuning.json]
```
同じく `MixTuning.json` を上の場所に置くと、おまかせミックスの EQ の動かし方に使われます。参照のつなぎが少ないうちは当てにしすぎないでください。

## 何を比べているか（つなぎ1つごと、100点満点）
| 項目 | 重み | 内容 |
|---|---|---|
| 入り | 30 | 次の曲をどこから入れたか（拍のずれ） |
| 抜け | 25 | 前の曲のどこで次の曲を重ね始めたか |
| 長さ | 15 | 重ねた長さ（2倍違うと約55点） |
| つなぎ方 | 10 | ブレンドかカット（ブレーキ・バックスピン含む）か |
| 低音の入れ替え | 10 | 重なりの中でベースが入れ替わる位置（推定精度は低め） |
| テンポ | 10 | 次の曲の再生速度の差 |

あわせて「位置の一致率」（1拍以内／4拍以内／16小節以内）を、プロ同士の一致率（23.6% / 40.4% / 86.2%）と並べて表示します。

## 精度について
- 合成テストでは、入り・抜け・カットの位置は 0.5 拍以内で取り出せました。
- 重なりの長さと低音の入れ替え位置は、似た音（同じキックなど）を使う曲同士だと推定がぶれます。
- DJ がエフェクトやループを多用した部分、同じ曲を2回使ったミックスは正しく取り出せません。
