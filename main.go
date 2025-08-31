package main

import (
	"context"
	"fmt"
	"log"

	"github.comcom/aws/aws-lambda-go/lambda"
	"github.com/chromedp/chromedp"
)

// HandleRequest is the main entry point for the Lambda function.
func HandleRequest(ctx context.Context) (string, error) {
	// --------------------------------------------------------------------------------
	// Lambdaコンテナ環境で動作させるためのchromedpオプション
	// --------------------------------------------------------------------------------
	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		// Google Chromeの実行ファイルのパスを明示的に指定
		chromedp.ExecPath("/opt/google/chrome/google-chrome"),
		// ヘッドレスモードで実行
		chromedp.Flag("headless", true),
		// GPUを使用しない
		chromedp.Flag("disable-gpu", true),
		// 共有メモリを使用しない (/dev/shmの使用を避ける)
		chromedp.Flag("disable-dev-shm-usage", true),
		// サンドボックスを無効化 (Lambda環境で必要)
		chromedp.Flag("no-sandbox", true),
		// シングルプロセスで実行
		chromedp.Flag("single-process", true),
	)

	allocCtx, cancel := chromedp.NewExecAllocator(context.Background(), opts...)
	defer cancel()

	// タイムアウトを設定したコンテキストを作成
	taskCtx, cancel := chromedp.NewContext(allocCtx, chromedp.WithLogf(log.Printf))
	defer cancel()

	// ページのタイトルを取得する簡単なテストを実行
	var title string
	err := chromedp.Run(taskCtx,
		chromedp.Navigate(`https://www.google.com`),
		chromedp.Title(&title),
	)

	if err != nil {
		log.Printf("Chromedp execution failed: %v", err)
		return "", fmt.Errorf("failed to run chromedp: %w", err)
	}

	log.Printf("Successfully got page title: %s", title)
	return fmt.Sprintf("Page title is: %s", title), nil
}

func main() {
	lambda.Start(HandleRequest)
}

