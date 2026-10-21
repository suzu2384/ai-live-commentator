## v4.49.2 更新内容

- KonDateのGoogle OAuth Client IDを流用していたv4.49.1の実装を撤回しました。
- みんコメAIは専用のGoogle OAuth Client IDをアプリへ組み込む方針に変更しました。
- 現時点では専用Client IDを未設定にし、Drive接続を無効化しています。
- Google OAuth Client IDの入力欄は引き続き表示しません。
- 専用Client IDが設定されたビルドでは、そのIDをアプリから自動使用します。
- Drive上の通常設定と秘密情報の2ファイル分離、保存・復元・削除の仕様は変更していません。
- Drive回帰テストでは本番IDを使わず、テスト専用Client IDを注入して検証します。
