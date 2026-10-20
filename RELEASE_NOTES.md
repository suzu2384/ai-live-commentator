## v4.49.1 更新内容

- Google OAuth Client IDの入力欄を削除しました。
- KonDateと同じ公開Web OAuth Client IDをみんコメAIへ組み込みました。
- Google Drive連携時はClient IDの入力・端末保存が不要になりました。
- Driveへ保存する `minkome-settings.json` / `minkome-secrets.json` にはClient IDを含めません。
- Google Driveの設定・秘密情報の分離保存、復元、削除、Free Tier確認非復元の仕様はv4.49.0のまま維持します。
- `file://` ではGoogle Web OAuthを利用できないため、Drive連携はGitHub Pagesまたは `http://localhost` で利用します。
- ブラウザ回帰で、Client ID入力欄が存在せず、組み込みClient IDでDrive接続できることを確認します。
