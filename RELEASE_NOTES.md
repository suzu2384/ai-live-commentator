## v4.51.0 更新内容

- Gemini接続に「個人APIキー（従来方式）」と「組み込みAI（Firebase）」の切り替えを追加しました。
- 従来のAPIキー方式は通信、暗号化保存、Driveバックアップ、実況、挨拶、チャプター生成を変更せずに維持しました。
- 組み込みモードはKonDate準拠のFirebase AI Logic（Gemini Developer API）とApp Check（reCAPTCHA Enterprise）で認証し、個人APIキーを不要にします。
- Firebase公開設定をGitHub Repository Variablesから同期するワークフローを追加しました。未設定では従来方式を継続できます。
- 組み込み版を有効化した新規利用者は組み込みモードを標準選択し、既存利用者はAPIキー方式を維持します。
- 将来的にAPIキー方式を廃止できるよう、組み込みAI接続アダプターを独立させました。
- Firebaseの応答・中断・利用上限と、ブラウザでのモード切り替えに回帰テストを追加しました。
