# michi — 予定メモ

iPhoneを主な利用端末として設計した、日本語のスケジュール管理PWAです。画面を開くと入力欄が見え、メモを入力すると予定の候補を表示します。2.4秒後に自動で端末へ保存する設定を初期状態で有効にしています。カウントダウン中はキャンセルでき、IMEで日本語を変換している間は保存しません。手動で追加する場合は「予定を追加」を押します。

公開プレビュー: [memo-calendar-glass.maponaru0519.workers.dev](https://memo-calendar-glass.maponaru0519.workers.dev) · ソース: [github.com/gorigram/memo-calendar](https://github.com/gorigram/memo-calendar)

## 技術構成

- UIはWorkerが返すHTML、CSS、JavaScriptです。アプリ画面は外部UIパッケージを実行時に読み込まず、WorkerのESM配信とオフライン起動に合わせています。
- `worker/parser.js` は決定的な日本語ルール解析を実装します。ブラウザ内の候補表示とWorker APIの規則ベース解析で共用し、IANAタイムゾーンを使って時刻を解決します。
- Cloudflare Workerが同一オリジンのAPI、PWA manifest、Service Worker、アイコンを配信します。公開Workerへデプロイ済みです。Service Workerは画面シェルのみをキャッシュし、API応答はキャッシュしません。
- 予定は最初にブラウザの`localStorage`へ保存します。Google認証後はD1を使い、端末のみの予定とクラウドの予定を区別して表示します。
- 公開WorkerにはD1 (`DB`) とWorkers AI (`AI`) のbindingを設定しています。D1はGoogle接続後の予定保存に使い、AIは任意の補助解析に使います。外部AIプロバイダーのAPIキーは不要です。AIを使えない場合もルール解析とローカル保存が動きます。
- Google Calendarへの自動同期は、Google接続後に設定でオンにした場合だけ実行します。同期結果が失敗や一部失敗なら画面にその状態を残します。

## メモ解析

- 日付を省略すると、端末タイムゾーンの今日として扱います。
- 開始時刻が必要です。開始時刻が見つからない、日付や時刻が矛盾する、相対日付が曖昧な場合は候補を作成しません。
- 終了時刻・所要時間を省略すると1時間です。所要時間、時間範囲、「午後3時半」などを指定できます。
- 「来週火曜」は月曜始まりの週で解決します。「来週」だけ、曜日だけなど日付を確定できない表現は確認を求めます。
- 「毎週」「毎日」「毎月」の繰り返しを保持します。週表示では繰り返し予定に`#1`、`#2`と回数を付けます。

規則解析は日本語の主要な日付・時刻表現に合わせた軽量実装です。自由な文章のすべてを解釈するものではなく、判断が安全でない場合は入力を修正できるようにします。

## 開発

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm validate
pnpm dev
```

本番QAでは個人のGoogleアカウントでOAuth接続を確認し、予定の作成、タイトル編集、所要時間変更をGoogle Calendar側でも確認しました。週次予定の自動同期後、再読み込みして当週分と翌週分が表示されることも確認しています。テスト予定をアプリから削除した後、Google Calendarで検索結果が空になることを確認し、QA用予定をアプリ・D1・Calendarから削除済みです。既存のGoogle Calendar予定を読み込む機能はなく、このアプリから作成・同期した予定を扱います。

Workers AIを使ったタイトル整理は本番で確認済みです。AIは予定タイトルの補助に使い、日付・開始時刻・終了時刻はルール解析と検証で決めます。試験は作成者の個人アカウントで行っており、複数利用者での運用確認ではありません。ブラウザーの1280px幅デスクトップ表示と390×844 CSSピクセルの固定フレーム表示を確認しました。モバイルフレームで「QAモバイル90min」を入力し、14:00–15:30の解析結果と端末内への自動保存を確認しました。実測幅390px・高さ844px、文書と本文の幅375pxで横はみ出しはありませんでした。フレーム内の編集操作は未確認です。iPhone実機Safariでの表示やホーム画面追加も未検証です。D1とWorkers AIのbindingは公開Workerに設定済みです。

Google OAuthは`External / Testing`モードで、現在は指定したテストユーザーだけが接続できます。Googleのテストモードでは、基本プロフィール以外のスコープを含む認可のrefresh tokenは7日で期限切れになるため、期限後は再接続が必要です。[Google OAuthのテストモードとrefresh token](https://developers.google.com/identity/protocols/oauth2/) · [OAuthアプリのテストユーザー設定](https://support.google.com/cloud/answer/15549945?hl=en)。WebアプリとGitHubのソースは公開していますが、Googleログインは一般公開ではありません。一般利用者へOAuthを提供する前に、Google側の公開設定やプライバシーポリシーなどを整え、利用範囲に応じた審査要件に従います。独自ドメインなども、その要件に合わせて準備します。

Lucide由来のアイコンのライセンスは[`worker/LUCIDE-LICENSE.txt`](worker/LUCIDE-LICENSE.txt)に収録しています。
