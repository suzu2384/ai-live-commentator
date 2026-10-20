## v4.49.0 更新内容

- Google Driveのアプリ専用領域（appDataFolder）へ、みんコメの保存データをバックアップ・復元できるようにしました。
- Drive上では通常設定と秘密情報を別ファイルで管理します。
  - `minkome-settings.json`: 現行の「設定をエクスポート」と同じ通常設定・友達設定・対象コンテンツ・追加知識・登録フォント。
  - `minkome-secrets.json`: Gemini APIキー、YouTube Data APIキー、OBSパスワード。
- Driveの秘密情報ファイルは、復元時に合言葉を要求しない方式として、みんコメ側では暗号化せず保存します。
- Free Tier確認チェックはDriveへ保存せず、復元後も再確認が必要です。
- 従来の「端末内の暗号化保存」は削除せず、そのまま併用できます。
- 「Google Driveに接続」しただけでは現在の設定を変更しません。「Driveへ保存」「Driveから復元」を明示的に押した時だけ読み書きします。
- Drive上に通常設定・秘密情報の片方しかない場合でも、存在する側だけを復元できます。
- 「Driveの保存を削除」はDrive上の2ファイルだけを削除し、端末内の設定・暗号化保存には触れません。
- Drive APIは `drive.appdata` スコープだけを要求します。
- Google OAuth Client IDは端末に記憶しますが、設定ファイルや秘密情報ファイルには保存しません。
- Google Web OAuthの仕様に合わせ、Drive連携はGitHub Pagesまたは `http://localhost` 起動時だけ有効にし、`file://` では理由を表示して無効化します。
- Drive APIとOAuthをモックした単体・ブラウザ回帰テストを追加しました。
