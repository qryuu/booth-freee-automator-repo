package main

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/aws/aws-lambda-go/lambda" // "github.comcom"から正しいパスに修正
	"github.com/chromedp/chromedp"
)

func HandleRequest(ctx context.Context) (string, error) {
	// ログにタイムスタンプを出力
	log.Printf("Lambda function started at %s", time.Now())

	// chromedpのオプションを設定
	// Lambda環境では、ヘッドレスモード、サンドボックス無効化、共有メモリ無効化が推奨されます。
	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.Flag("headless", true),
		chromedp.Flag("disable-gpu", true),
		chromedp.Flag("disable-dev-shm-usage", true),
		chromedp.Flag("disable-software-rasterizer", true),
		chromedp.Flag("no-sandbox", true),
		chromedp.ExecPath("/opt/google/chrome/chrome"), // Google Chromeの実行パスを指定
	)

	allocCtx, cancel := chromedp.NewExecAllocator(context.Background(), opts...)
	defer cancel()

	taskCtx, cancel := chromedp.NewContext(allocCtx, chromedp.WithLogf(log.Printf))
	defer cancel()

	var pageTitle string
	err := chromedp.Run(taskCtx,
		chromedp.Navigate(`https://www.google.com`),
		chromedp.Title(&pageTitle),
	)

	if err != nil {
		log.Printf("Chromedp execution failed: %v", err)
		return "", fmt.Errorf("failed to navigate and get title: %w", err)
	}

	log.Printf("Successfully navigated to Google. Page title: %s", pageTitle)
	return fmt.Sprintf("Successfully got title: %s", pageTitle), nil
}

func main() {
	lambda.Start(HandleRequest)
}

