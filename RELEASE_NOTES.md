## v4.49.3 更新内容

- Google OAuth Client IDの管理方式をKonDateと同様にGitHub ActionsのRepository Variableへ変更しました。
- Repository Variable名は `GOOGLE_OAUTH_CLIENT_ID` です。
- KonDateのClient IDは流用しません。みんコメAI専用のWeb OAuth Client IDを設定してください。
- `Sync Google OAuth config` ワークフローがRepository Variableから公開用 `google-config.js` を生成してmainへ同期します。
- 同期後はGitHub Pagesの再ビルドを明示的に要求するため、変数設定後に同期ワークフローを1回実行すれば公開版へ反映できます。
- Client ID入力欄は引き続き表示しません。
- `GOOGLE_OAUTH_CLIENT_ID` が未設定の場合はGoogle Drive接続だけを無効化します。
- Drive上の通常設定と秘密情報の2ファイル分離、保存・復元・削除の仕様は変更していません。
