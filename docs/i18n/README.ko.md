# DJAW

[日本語](../../README.md) | [English](README.en.md) | [简体中文](README.zh-Hans.md) | [繁體中文](README.zh-Hant.md) | **한국어** | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Italiano](README.it.md) | [Português](README.pt.md) | [Русский](README.ru.md)

DAW 스타일(비실시간) DJ 믹스 편집기입니다. 마디 단위 가이드로 곡을 잇고, 페이더·EQ·FX·보컬의 움직임을 그려서 믹스를 내보냅니다. Windows와 Mac(Apple 실리콘)에서 동작합니다.

- `src/` — Windows / Mac 공용판 (Electron + TypeScript)
- `mac/` — 이전 macOS판 (SwiftUI). 원래 동작 사양의 기준
- 설계 상세 → [`docs/PORTING.md`](PORTING.ko.md) (각 언어판은 `docs/i18n/`)

개인 사용을 위한 앱입니다 (동봉된 일부 모델은 비상업 라이선스).

## 설치

[Releases](https://github.com/WVYYYVW/DJAW/releases)에서:
- **Windows**: `DJAW-Setup-x.y.z.exe`
- **Mac (Apple 실리콘)**: `DJAW-x.y.z-mac-arm64.dmg`

한 번 설치하면 시작할 때 새 버전으로 자동 업데이트됩니다.

## 소스에서 실행

[Node.js](https://nodejs.org/) 22 이상(LTS)과 Git이 필요합니다.

```bat
git clone https://github.com/WVYYYVW/DJAW.git
cd DJAW
npm install
npm start
```

- `npm start` … 빌드한 뒤 실행합니다 (개발용).
- `npm run dist` … 설치 프로그램을 만듭니다 (`dist/`).
- `npm test` … 렌더링 엔진 테스트 (소리는 나지 않습니다).

분석 결과와 오디오 캐시는 `%APPDATA%\DJAW` (Mac은 `~/Library/Application Support/DJAW`)에 저장됩니다.

## 언어

日本語, English, 简体中文, 繁體中文, 한국어, Español, Français, Deutsch, Italiano, Português, Русский.
처음에는 시스템 언어로 시작하며, "언어" 메뉴에서 바꿀 수 있습니다.

## 화면

Ableton Live와 비슷한 구성입니다.
- 위: 파일 이름, 재생·시간·BPM·스냅 (창 가운데), 비주얼, 연주 가이드, 내보내기
- 왼쪽: 브라우저 (믹스 순서와 라이브러리). 드래그로 너비와 위아래 비율을 바꿀 수 있습니다. 라이브러리는 폴더 정리, 검색, 정렬 (이름·BPM·키·선택한 곡과의 궁합 등, 전체 곡 또는 폴더별), 드래그로 순서 변경
- 가운데: 어레인지 화면 (덱 A / B, 겹치는 곡용 덱 C / D, MIX, 샘플러. 샘플러 레인은 숨길 수 있음)
- 아래: 상세 패널 (Ctrl+Alt+I). 탭: 개요·믹스·트랙·전환·CUE·루프·FX·샘플러·덱. Ctrl+Alt+F로 최대화. 16:9 전체 화면에서는 전환 편집기가 스크롤 없이 모두 보입니다

## 기능

- 곡 추가와 분석: BPM·다운비트 (Beat This!)·구성 (인트로·드롭 등, CUE 편집기에도 표시)·키·라우드니스·장르 (EffNet)·AI CUE 후보 (CUE-DETR). iTunes / 음악 보관함에서 추가
- 타임라인 편집: 곡이 겹치는 위치와 길이, 컷인, 루프 / 점프, FX
- **템포 변경**: 믹스 도중에 BPM을 바꿉니다. 변경을 시작할 위치 (전환 후, 전환과 동시 등)와 몇 마디에 걸쳐 바꿀지 지정 (예: −7.5% 곡을 8마디에 걸쳐 0.0%로 되돌리기)
- **곡 겹치기 (4덱)**: 어떤 곡 위에 다른 곡을 통째로 겹쳐 재생 (덱 C / D). 보컬만·반주만도 선택 가능. 덱 표시와 믹서도 4채널
- **루프 중 전환**: 루프의 몇 번째 반복에서 다음 곡으로 넘어갈지 선택
- 전환 편집기: 페이더·EQ·필터·에코·리버브·보컬 / 드럼 / 베이스 / 멜로디 라인을 그립니다. 프리셋, 후보 (테이크), 나만의 전환 저장
- 자동 믹스 (패턴·후보·렌더링 확인), 자동 배치 (곡 순서 포함), 연주 가이드와 SoundCloud용 트랙 리스트
- 스템 분리: 보컬·드럼·베이스·멜로디 (Spleeter 4stems)
- 샘플러: 8패드 (Q–I 키), 박 위치에 배치 (녹음·롤·음량). 내장 사운드 (에어혼·덥 사이렌·라이저·임팩트·개버 킥 등)는 모두 DJAW를 위해 합성한 오리지널 사운드로, 믹스·라이브·업로드에 자유롭게 쓸 수 있습니다
- 내보내기: WAV (24비트) / M4A (AAC 256 kbps), 44.1 / 48 kHz, 비주얼이 들어간 MP4 (오토 VJ), 실시간 비주얼 미리보기 (Ctrl+Alt+V)
- 저장: 오디오까지 담은 `.djaw` 파일 하나 (WAV 등 비압축 곡은 무손실 FLAC으로 약 절반 크기, 음질은 동일). 시작할 때 지난번 믹스를 자동으로 엽니다

미리듣기 재생은 내보내기와 같은 엔진을 쓰므로, 들리는 소리가 그대로 내보내집니다.

모델 라이선스: `models/ThirdPartyNotices.txt` (EffNet은 비상업).
