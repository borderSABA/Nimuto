# NIMT ONLINE v2.1

Cloudflare Workers + Durable Objects と GitHub Pages を分離したオンライン版です。

## 公開URL

- GitHub Pages（プレイ用）  
  `https://bordersaba.github.io/Nimuto/`

- Cloudflare Workers（対戦サーバー）  
  `https://nimto-online.naitoryo7110.workers.dev`

GitHub Pagesから開いた場合、API / WebSocket は自動的に上記Workersへ接続します。

## GitHubへアップするもの

このZIPを展開した**中身をすべて**、GitHubリポジトリ `Nimuto` の直下へ上書きしてください。

重要なのは次の構成です。

```text
Nimuto/
├─ index.html              ← GitHub Pagesが表示するゲーム本体
├─ package.json
├─ wrangler.jsonc
├─ README.md
├─ 0_CHECK_ENVIRONMENT.bat
├─ 1_DEPLOY_SERVER.bat
├─ DEPLOY_SERVER.bat
├─ 2_LOCAL_TEST.bat
├─ public/
│  └─ index.html           ← Workers直アクセス時のゲーム本体
└─ src/
   └─ index.js             ← Durable Objects / API / WebSocket
```

## 更新手順

1. ZIPを展開します。
2. 中身をGitHubの `Nimuto` リポジトリへ上書きします。
3. GitHub Pagesはルートの `index.html` を読み込むため、README表示ではなくゲーム画面になります。
4. ローカルの同じフォルダで `DEPLOY_SERVER.bat` を実行してWorkersも再デプロイします。
5. Workers再デプロイ後、GitHub PagesからAPIへ接続できます。

## v2.1修正点

- GitHub Pages用 `index.html` をリポジトリ直下へ追加
- GitHub PagesからのAPI接続先を `https://nimto-online.naitoryo7110.workers.dev` に固定
- GitHub PagesからのWebSocket接続先を同Workersへ固定
- Worker APIへCORSレスポンスを追加
- `/api/reset` のCORSプリフライトに対応
- Workers直アクセス / `wrangler dev` は従来どおり同一origin接続
