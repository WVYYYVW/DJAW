# Windows 이식: 설계 상세·대응표·주의점

[日本語](../PORTING.md) | [English](PORTING.en.md) | [简体中文](PORTING.zh-Hans.md) | [繁體中文](PORTING.zh-Hant.md) | **한국어** | [Español](PORTING.es.md) | [Français](PORTING.fr.md) | [Deutsch](PORTING.de.md) | [Italiano](PORTING.it.md) | [Português](PORTING.pt.md) | [Русский](PORTING.ru.md)

`CLAUDE.md`의 후속 문서입니다. Mac판(`mac/DJAW`)의 코드가 **사양의 원본**입니다. 수치·곡선·임곗값은 그대로 옮길 것
(거의 모두 사용자가 오랜 시간 귀로 조정해 온 값입니다).

> 일본어 원문이 기준이며, 이 문서는 번역본입니다.

---

## 1. Electron 앱 구성

```
package.json            electron, vite, typescript, react, signalsmith-stretch, music-metadata, onnxruntime-node, electron-builder
src/main/               Electron main: 창, 메뉴 (Mac판 MyApp.swift의 메뉴 구성), 대화상자, 자동 저장, 최근 파일
src/core/               UI에 의존하지 않는 TypeScript (Node 단독으로 테스트할 수 있을 것)
  models.ts             Models.swift (Clip, TransitionShape, TransitionLanes, AutoPoint, ClipEdit, CuePoint, TransitionTake, ClipPalette, ProjectFile…)
  tempo.ts              TempoFX.swift (TempoMap, OutroFX, FXKind, FXShape, ClipFX, FXState)
  automation.ts         Automation.swift
  layout.ts             MixStore.layout(), updateCutNudges(), suggestedMixOut() 등
  project.ts            .djaw 읽기/쓰기 (DJAWPACK)
  analysis/*.ts         AudioAnalyzer, StructureAnalyzer, LoudnessAnalyzer, NeuralAnalyzer(ONNX), AnalysisCache
  render/*.ts           Voice (읽기 → 늘이기 → EQ → FXKernel → 에코 → 리버브 → 페이더), RenderSession, WAV 내보내기, 믹스 파형
  i18n.ts               L(ja, en)
src/workers/            render.worker.ts (미리듣기·내보내기·파형. Web Worker), analysis.child.ts (분석. 자식 프로세스)
src/renderer/           React UI (store.ts = MixStore의 UI 상태 부분, components/…)
src/vendor/stretch-core.mjs   tools/signalsmith/make-core.mjs로 생성
tests/                  core 테스트 (Node)
```

- `BrowserWindow`는 `nodeIntegration: true, contextIsolation: false, nodeIntegrationInWorker: true`로 충분합니다
  (로컬 파일만 다루는 개인용 앱. Worker에서 fs를 직접 쓸 수 있는 것이 큰 장점).
- 상태 관리: MixStore는 "문서 (clips, library, masterBPM, gridOffset…) + UI 상태".
  문서 부분은 순수 함수 (`core/`)로 갱신하고, Undo는 Mac판과 같이 스냅숏 (최대 300개).
- ID: Swift의 UUID는 대문자 문자열로 저장됨 → `crypto.randomUUID().toUpperCase()`.

## 2. 오디오 데이터 처리

- **디코딩**: renderer에서 `OfflineAudioContext(2, 1, 44100).decodeAudioData(buf)` → 44.1kHz로 통일.
  AIFF는 Chromium이 읽지 못하므로 직접 파싱 (헤더 + 빅엔디언 PCM).
- **PCM 캐시**: `<userData>/cache/pcm/<지문>.pcm` (16bit 스테레오 인터리브, 헤더에 길이와 샘플레이트).
  읽기는 `fs.readSync`로 필요한 범위만. 곡 길이는 원본 파일의 샘플 수 / 원본 샘플레이트로 (Mac판 `duration`과 일치시키기 위해).
- **지문** (`AnalysisCache.fingerprint`): SHA-256 (`"<크기>"` + 앞부분 256KB + 크기 > 512KB이면 끝부분 256KB). 소문자 16진수.
  분석·프로필·스템 캐시는 모두 이것이 키. Mac판과 같은 값이 나오므로 `.djaw`의 `profiles` 등을 공유할 수 있습니다.
- **메타데이터**: `music-metadata` (제목·아티스트·아트워크·장르 태그).

## 3. 렌더링 엔진 (가장 중요)

Mac판 `MixRenderSession` / `PlaybackEngine.swift` / `DJFX.swift` / `StreamingPlayback.swift` / `OfflineRenderer.swift`를 읽을 것.

### 시간 단위
- 타임라인은 **reference 초** (기준 BPM = `masterBPM`에서의 초). 템포 변경이 있으면 실제 시간 (real)과 어긋납니다.
  `TempoMap.real(t)`, `reference(atReal:)`로 변환. 샘플 위치는 항상 **real 초 × 샘플레이트**.
- 곡 `c`의 재생 속도 `rate = master / c.bpm` (`tempoSync`일 때). 템포 맵 아래에서는 `c.rate(tempo.bpm(at: t))`.
- 한 곡이 재생하는 원본 구간은 `playSegments()` (루프·점프 포함). 경과 `elapsed`는 원본의 초.

### 스텝
- 믹스 처음부터 세어 **512프레임 경계**마다 1스텝. 곡의 시작 프레임이 스텝 중간에 있으면 거기서 자릅니다 (`nextChunk`).
- 각 스텝 중앙의 시각 `t`에서 `Automation.state(clips, i, t, master)`를 평가해 모든 성부에 적용.
- 곡마다의 성부는 그 곡의 시작 프레임 **정확히**에서 움직이기 시작합니다 (Mac판에서는 도중에 합류한 늘이기 유닛의 어긋남으로 오래 고생했습니다).
  끝난 뒤에도 에코·리버브 잔향을 위해 `tail = 8`초 동안 움직입니다.

### 성부의 내용 (Chain)
1. **읽기** (`ClipSchedule.ranges` / `BufferFeeder`): 구간마다 읽기.
   첫 구간 머리에 **3ms 페이드 인**. 다음 곡이 `cut`이면 마지막 **5ms 페이드 아웃**.
   브레이크 / 백스핀 (`OutroFX`)은 끝부분을 `TurntableFX.render`의 결과로 교체 (그대로 이식).
2. **늘이기·피치**: signalsmith-stretch. `stretchRate` (정확히 1이면 1.00002로 해서 항상 처리).
   키 락 OFF (레코드)이면 `pitchCents`만큼 트랜스포즈, 키 시프트 ±6반음.
   출력 블록마다 `inN = round(outN × rate)` (나머지는 이월해 누적 오차 0).
   지연 (44.1k에서 입출력 합계 5292샘플)은 성부 시작 시 "시작 위치보다 앞의 입력"으로 시크한 뒤 출력을 버리는 등으로 **정확히 상쇄**.
   테스트: 클릭 열을 통과시켜, 출력의 클릭 위치가 `(입력 위치 − 시작 위치) / rate`와 ±1샘플 이내로 일치할 것.
3. **EQ** (`DJEQ.configure`): 로 셸프 180Hz / 피킹 1kHz·대역폭 2옥타브 / 하이 셸프 4.5kHz.
   게인은 `state.low/mid/high` (dB, 킬은 −40dB, MID는 −24dB). Apple AVAudioUnitEQ 상당의 바이쿼드 필터로.
4. **DJ FX**: `FXKernel` (필터·페이저·플랜저·비트크러셔·게이트·롤)은 샘플 단위 처리이므로 **그대로 이식**.
5. **에코**: AVAudioUnitDelay 상당 (지연 = 박 × 0.75 (에코 아웃) 또는 `echoDiv`, 피드백 55% (FX일 때는 30 + 30 × 양),
   로패스 7kHz, wet/dry). 에코 아웃에서는 1박 뒤 `send`를 0으로 해 잔향만 남깁니다.
6. **리버브**: AVAudioUnitReverb의 largeHall2 상당 (Freeverb 등 비슷한 울림으로). wet = 55% × 양.
7. **페이더**: `state.volume` (게인 × 라우드니스 보정 × 포락선).

- **스템** (3단계): 보컬 / 반주 두 읽기를 섞은 뒤 늘이기로 (`stemMix`).
- **미리듣기**: 같은 세션을 Worker에서 0.25초 앞까지 렌더링해 AudioWorklet로 보냅니다.
  레벨·EQ·FX·곡선만의 변경은 렌더링 중인 세션에 반영 (`update`). 소리의 위치가 바뀌는 변경 (`structureKey`가 바뀜)은 현재 위치에서 다시 만듭니다.
  재생 위치 표시는 "Worklet이 실제로 낸 프레임 수"에서 구하고, 표시 쪽은 보간해 부드럽게 (Mac판 `smoothPlayhead`).
- **내보내기**: WAV 24bit와 M4A (AAC 256kbps), 44.1k/48k. 정규화는 피크를 −1dBFS로 (증폭은 최대 4배, `OfflineRenderer.normalizeGain`). 정규화 시 1회차에 피크를 재고 2회차에 씁니다 (믹스 파형의 피크를 쓸 수 있으면 1회로 끝). 남은 시간은 안정 단계에 들어간 뒤 추정.

## 4. `.djaw` 형식 (Mac판과 서로 읽고 쓰기)

```
"DJAWPACK"            8 bytes
version               UInt32 LE (=1)
jsonLength            UInt64 LE
JSON                  ProjectFile (키 정렬, 날짜는 ISO8601)
오디오 파일            원본 파일의 바이트열을 그대로 연결 (media[].offset은 JSON 바로 뒤부터의 상대 위치)
```
- 처음이 `DJAWPACK`이 아니면 평범한 JSON (옛 형식·자동 저장).
- `ProjectFile`: `format:"DJAW-Mix"`, `version:2`, `masterBPM`, `gridOffset`, `snap`, `clips`, `library`, `media`, `analyses`,
  `profiles`, `customTransitions`, `loudnessMode`, `ui`, `projectID`, `notes` 등 (`Models.swift` 끝).
- `clips[].url`은 `file:///Users/...` 형태의 URL 문자열 (Mac 경로). 열 때의 해석 순서: 내장 오디오 (`mediaID` → 풀어 둔 폴더) → `relativePath` (.djaw 기준 상대) → `url` → 못 찾으면 "찾을 수 없는 파일"로 다시 연결을 요청.
  저장 시 Windows 경로는 `file:///C:/...`로 씁니다.
- 내장 오디오를 푸는 곳: Mac은 `~/Library/Application Support/DJAW/Media/<projectID>/<mediaID>-<원래 파일 이름>`. Windows는 `%APPDATA%/DJAW/Media/<projectID>/`.
- `analyses`: 지문 → Mac판의 분석 결과 (LZFSE 압축 바이너리 plist). Windows에서는 읽지 못해도 되지만 (직접 다시 분석),
  **저장할 때 지우지 않고 그대로 남기면** Mac에서 열 때 다시 분석할 필요가 없습니다. Windows판의 분석 결과는 다른 키 (예: `analysesWin`)에.
- 실제 예: 사용자의 `hyperflip.djaw` (약 400MB, 9곡 내장, 믹스 5곡 + 라이브러리 4곡, masterBPM 107, 템포 변경 있음, 사용자 레인 있음).

## 5. Swift → TypeScript 대응표

| Swift | 줄 수 | 역할 | 단계 | 메모 |
|---|---:|---|:-:|---|
| Model/Models.swift | 1301 | 클립·곡선·레인·후보·팔레트·ProjectFile | 1 | 계산은 그대로 |
| Model/TempoFX.swift | 399 | 템포 맵·FX 정의 | 1 | |
| Model/Automation.swift | 260 | 시각별 음량·EQ·FX·스템, 전환점 | 1 | 재생과 내보내기 공통 |
| Model/Localization.swift | 43 | 일본어/영어 전환 | 1 | |
| Model/PerformanceGuide.swift | 454 | 연주 순서·트랙 리스트 | 2 | |
| Model/AutoMixer.swift | 857 | 자동 믹스 계획 | 2 | |
| Audio/AudioAnalyzer.swift | 503 | 읽기·파형·BPM·다운비트·대역 에너지 | 1 | |
| Audio/StructureAnalyzer.swift | 517 | 구성 (인트로 / 빌드 / 드롭…)·키 | 1 | 자동 믹스와 가이드의 토대 |
| Audio/NeuralAnalyzer.swift | 603 | Beat This! (박)·CUE-DETR (CUE 후보) | 1/2 | ONNX 변환 필요 |
| Audio/GenreAnalyzer.swift | 487 | 장르 (EffNet)·보컬 유무 | 2 | ONNX 있음 |
| Audio/LoudnessAnalyzer.swift | 134 | LUFS (BS.1770) | 1 | |
| Audio/AnalysisCache.swift | 169 | 지문·분석 캐시 | 1 | |
| Audio/AnalysisProgress.swift | 216 | 분석 진행·남은 시간 | 1 | |
| Audio/PlaybackEngine.swift | 662 | Chain, ClipSchedule, BufferFeeder | 1 | AVFoundation 부분은 자체 DSP로 교체 |
| Audio/MixRenderSession.swift | 299 | 믹스 렌더링 본체 | 1 | |
| Audio/StreamingPlayback.swift | 185 | 미리듣기 | 1 | Worker + AudioWorklet |
| Audio/OfflineRenderer.swift | 301 | 내보내기·믹스 파형 (부분 렌더링) | 1 | |
| Audio/DJFX.swift | 464 | FXKernel·브레이크 / 백스핀 | 1 | 그대로 이식 |
| Audio/StretchCalibration.swift | 118 | AVAudioUnitTimePitch 속도 어긋남 보정 | — | **불필요** (signalsmith는 입력 수를 직접 지정 가능) |
| Audio/TransitionCheck.swift | 187 | 자동 전환의 시청 확인 | 2 | |
| Audio/StemSeparator.swift | 231 | Spleeter 보컬 분리 | 3 | ONNX 변환 필요 |
| Audio/MusicLibrary.swift | 97 | 음악.app 보관함 | 2 | iTunes / 음악 보관함 XML 읽기 (`src/core/musicLibrary.ts`) |
| Store/MixStore.swift | 3352 | 상태·편집 조작·레이아웃·재생·저장·내보내기 | 1(+2) | 자동 믹스 부분은 2단계 |
| Store/MixStore+Locks.swift | 83 | 전환 잠금 | 1 | |
| Store/MixStore+Loudness.swift | 55 | 라우드니스 맞추기 | 1 | |
| Store/MixStore+MixWaveform.swift | 267 | 믹스 파형 (차분 그리기·유휴 시 전체) | 1 | |
| Store/MixStore+Simplify.swift | 169 | 전환 단순화 | 1 | |
| Store/MixStore+Takes.swift | 92 | 전환 후보 | 1 | |
| Store/MixStore+Profiles.swift | 105 | 곡 정보·아트워크 | 2 | |
| Store/MixStore+Stems.swift | 49 | 스템 준비 | 3 | |
| Store/ProjectContainer.swift | 136 | .djaw 형식 | 1 | |
| Store/DebugHarness.swift | 514 | 개발용 자동 테스트 명령 | — | Windows에서는 Node 테스트로 대체 |
| Timeline/TimelineNSView.swift | 1655 | 타임라인 (A/B 2레인, 마디 눈금자, 전환 띠, 드래그 조작, 믹스 파형, 재생 헤드 추적) | 1 | Canvas. 보이는 범위만 그리고 재생 헤드만 다시 그림 |
| Timeline/TimelineHost.swift | 50 | | 1 | |
| Views/InspectorView.swift | 2452 | 오른쪽 패널 (전환·덱·FX·믹서·후보·곡 사용법) | 1 | |
| Views/TransitionEditorView.swift | 836 | 전환 편집기 (레인 그리기, 눈금자에서 시청) | 1 | |
| Views/CueEditorView.swift | 891 | CUE 편집기 (단독 시청, IN/OUT, 그리드 조정) | 1 | |
| Views/DeckPanel.swift | 593 | 턴테이블·믹서 표시 | 1 | 보간한 시계로 부드럽게 회전 |
| Views/SidebarView.swift | 347 | 곡 순서·라이브러리 | 1 | |
| Views/TransportViews.swift | 156 | 재생 버튼·시간·BPM | 1 | |
| Views/ExportSheet.swift | 179 | 내보내기 | 1(음성)/3(영상) | |
| Views/ShortcutsView.swift | 116 | 단축키 목록 | 1 | ⌘를 Ctrl로 바꿔 읽기 |
| Views/AnalysisProgressView.swift | 48 | 분석 진행 | 1 | |
| Views/Theme.swift | 108 | 색·서식 (Fmt) | 1 | |
| Views/AutoArrangeSheet.swift | 340 | 자동 배치 | 2 | |
| Views/PerformanceGuideView.swift | 162 | 연주 순서·트랙 리스트 | 2 | |
| Views/TrackProfileSheet.swift | 164 | 곡 정보 편집 | 2 | |
| Views/MusicLibrarySheet.swift | 313 | 음악.app | 2 | XML이 없으면 파일을 선택 |
| Views/VisualPreviewView.swift | 84 | 비주얼 미리보기 | 3 | |
| Media/TrackProfiles.swift | 123 | 곡 프로필 저장 | 2 | |
| Media/VideoExporter.swift | 445 | 영상 내보내기 | 3 | |
| Media/VisualPainter.swift | 583 | 영상 그리기·오토 VJ | 3 | Canvas/WebGL |
| MyApp.swift / ContentView.swift | | 메뉴·전체 레이아웃 | 1 | |

## 6. ML 모델 (ONNX 필요)

라이선스는 `mac/DJAW/ML/ThirdPartyNotices.txt`. 전처리용 행렬 (`*_fbank_*.f32`, `*_melfb_*.f32`)과 레이블은 `mac/DJAW/ML/`에 있습니다.
원본 데이터는 사용자 Mac의 `~/Downloads`에 있습니다 (필요해지면 사용자에게 Windows로 복사해 달라고 합니다. 권한은 처음에 한꺼번에 묻습니다).

| 모델 | 원본 데이터 (Mac의 ~/Downloads) | Windows에서의 형태 |
|---|---|---|
| Beat This! (박·마디 머리, MIT) | `final0.ckpt` (81MB, PyTorch) | `beat_this` 공식 코드로 읽어 ONNX로 내보내기. 전처리는 `beatthis_fbank_513x128.f32`. 추론은 onnxruntime-node |
| CUE-DETR (CUE 후보, MIT) | `model.safetensors` (166MB, HF transformers의 DETR) | transformers로 읽어 ONNX로. 전처리 `cuedetr_melfb_128x1025.f32` |
| Discogs-EffNet (장르, CC BY-NC-SA) | `DJAW_genre_models/discogs-effnet-bsdynamic-1.onnx`, 헤드 `genre_discogs400-...pb`, `DJAW_heads/*.onnx` | 본체와 헤드 4개는 ONNX 그대로 사용 가능. genre400 헤드는 .pb → ONNX (tf2onnx), 또는 가중치를 꺼내 행렬 계산 |
| Spleeter 2stems (MIT) | Mac판에서는 PyTorch로 다시 짜서 Core ML로 변환 (TF와 상대 오차 8e-6으로 일치 확인됨) | 같은 순서로 ONNX로. STFT 4096/1024, 1024빈 × 512프레임, 반주 = 원음 − 보컬 |

추론은 analysis.child (Electron을 Node로 실행한 자식 프로세스)에서. **onnxruntime-node는 renderer의 Web Worker에서는 동작하지 않기** 때문입니다 (불러오면 renderer째로 죽음). Mac판의 전처리 (`NeuralAnalyzer.swift`, `GenreAnalyzer.swift`, `StemSeparator.swift`)를 엄밀히 옮길 것.

## 7. 주의점·경위 (Mac판에서 알게 된 것)

- **내보내기와 미리듣기의 일치**: Mac판은 처음에 미리듣기용으로 별도의 실시간 경로가 있어서, 곡이 들어오는 위치가 내보내기와 어긋났습니다.
  결국 "미리듣기도 내보내기와 같은 세션으로 렌더링해 흘려보내는" 형태로 했습니다. Windows판은 처음부터 이 형태로.
- **늘이기 유닛의 지연과 속도 어긋남**: 도중에 합류한 성부가 늦거나 빨라지고, 설정 속도와 실제 속도의 차이로 박이 흘러감 (0.23ms/초).
  signalsmith를 직접 쓰면 둘 다 원리적으로 일어나지 않지만, 반드시 테스트로 확인.
- **컷인** (`updateCutNudges`): 마디선은 어택 (킥 / 스네어)에서 10~40ms 어긋나 있을 때가 있습니다.
  나가는 곡은 다음 어택 직전에 멈추고, 들어오는 곡은 자기 어택 직전부터 시작 (`BandEnergies.onsetOffset`의 2ms 포락선으로 검출).
  겹침은 5ms만 남기고, 나가는 쪽 5ms 페이드 아웃·들어오는 쪽 3ms 페이드 인.
- **자동화 평가 시각**: 스텝 경계는 믹스 처음 기준 (중간부터 재생해도 같은 순간에 평가).
- **시작 직전 레벨**: 시작 0.25초 전인 곡은 시작 직후의 값을 미리 넣어 둡니다 (컷인의 머리가 빠지지 않도록).
- **믹스 파형**: 음압이 높은 곡은 항상 클리핑되어 피크만으로는 빨간 띠가 됨 → 피크 + RMS 심으로 그리기.
  변경된 범위만 10초의 도움닫기를 붙여 다시 그리고, 뒤는 시간 방향으로 밀어 재사용. 20초 조작이 없으면 전체를 정확히 다시 그림.
- **타임라인의 무거움**: 곡이 늘면 무거워짐 → 보이는 범위만 그리기, 재생 중에는 재생 헤드 띠만 무효화, 템포 맵 등은 리비전 단위로 캐시.
- **색**: 이웃한 곡은 색상 거리 0.15 이상 (`separateNeighbourColors`).
- **같은 곡의 이중 불러오기 금지**: (정규화한) 경로와 지문 둘 다로 판정. 타임라인에 놓은 곡이 라이브러리에 있으면 그것을 믹스로 옮김.
- **턴테이블**: 60Hz 타이머와 오디오 시계의 단차로 끊김 → 보간한 시계 (오차를 15%씩 보정, 50ms 이상 어긋나면 다시 맞춤)로 화면 갱신마다 그리기.
- **오토 VJ**: 너무 짧은 간격으로 바뀜 → 8마디 프레이즈 단위, 드롭 머리에서 전환, 최소 2프레이즈 유지.
- **내보내기 남은 시간**: 처음 추정은 믿을 수 없음 → 안정 단계에 들어간 뒤의 진행만으로 추정하고 5초 / 10초 단위로 반올림.

## 8. 검증 데이터

사용자 Mac의 `~/Downloads` (필요하면 복사를 요청):
- `hyperflip.djaw` (Mac판 믹스, 오디오 내장), `hyperflip.wav` (그 내보내기)
- `DJAW_pv_export*.wav` (미리듣기와 내보내기 비교에 쓴 내보내기)
- 곡: `chance-FINAL.wav`, `TURN OFF THE LIGHTS REMIX FINISHED!!!.wav`, `you dont need to fall.mp3`, `01 welcome.wav` 외

## 9. 0.4.0에서 추가한 사양

- **템포 변경 시작 위치** (`Clip.tempoStart`): `'afterTransition'` (전환 후. 새로 템포 변경을 만들 때의 기본값)·`'mixIn'` 또는 미설정 (전환과 동시. 0.3 이전의 믹스)·숫자 (곡에 들어온 뒤의 마디 수).
  변화는 `timelineTimeOfBar(c, c.mixInBar + tempoStartBars(c))`에서 시작해 `tempoRampBars(c)` (`Clip.tempoBars`, 미설정이면 전환 길이) 마디에 걸쳐 다음 BPM으로.
- **겹치는 곡** (`ProjectFile.layers`, `Clip.layerOf`·`layerBar`·`layerParts`): 믹스 곡 (호스트)의 마디에 고정해 그 위에서 울림.
  위치는 `core/layers.ts`의 `placeLayers`, 덱 C / D 할당은 `layerDecks` (동시에 최대 2곡).
  렌더링은 겹치는 곡마다 한 곡짜리 RenderSession을 만들어 `renderNext()`에서 합산 (`nextChunk`는 모든 세션의 최솟값).
  `layerParts`가 `vocals` / `instrumental`이면 스템을 쓰고, `Automation.state`가 다른 쪽을 0으로 함.
- **루프 중 전환** (`Clip.outPass`): 이전 곡이 루프 중일 때 몇 번째 반복에서 전환할지. `elapsedOfSourcePass`로 레이아웃에 반영.
- **다국어**: `L(ja, en)`의 영어를 키로 한 표 (`src/core/locales/<lang>.json`). 영어가 템플릿 문자열인 호출에는 빌드 시 `scripts/i18n.mjs`가 키와 값을 붙임.
  자동 믹스 메모처럼 저장되는 문장은 `captureLanguages()`로 모든 언어의 표시를 남기고, 표시할 때 `localize()`로 현재 언어로.
  키 추출은 `node scripts/i18n.mjs extract`, 번역 결합은 `node scripts/i18n-merge.mjs` (`_parts/c<N>_*.json`, 200개씩).
- **저장 크기**: 내장하는 비압축 오디오 (WAV)는 FLAC (`core/flac.ts`, 고정 예측 + 라이스 부호, 원본과 비트 단위로 일치)으로 넣습니다. MP3 등은 그대로.
