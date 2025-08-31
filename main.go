package main

import (
	"context"
	"fmt"
	"log"

	"github.com/aws/aws-lambda-go/lambda"
	"github.com/chromedp/chromedp"
)

// HandleRequest is the main entry point for the Lambda function.
func HandleRequest(ctx context.Context) (string, error) {
	log.Printf("Lambda function started")

	// Set up options for headless Chrome execution in Lambda.
	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.ExecPath("/opt/google/chrome/google-chrome"),
		// Base flags for Lambda
		chromedp.Flag("headless", true),
		chromedp.Flag("no-sandbox", true),
		chromedp.Flag("disable-gpu", true),
		chromedp.Flag("disable-dev-shm-usage", true),
		chromedp.Flag("single-process", true),
		chromedp.Flag("disable-setuid-sandbox", true),
		chromedp.Flag("window-size", "1920,1080"),
		chromedp.Flag("user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.102 Safari/537.36"),

		// Writable directories
		chromedp.Flag("user-data-dir", "/tmp/user-data"),
		chromedp.Flag("data-path", "/tmp/data-path"),
		chromedp.Flag("disk-cache-dir", "/tmp/cache-dir"),
		chromedp.Flag("homedir", "/tmp"),

		// Process management
		chromedp.Flag("disable-zygote", true),

		// Disable unnecessary background tasks
		chromedp.Flag("disable-extensions", true),
		chromedp.Flag("disable-background-networking", true),
		chromedp.Flag("disable-sync", true),
		chromedp.Flag("no-first-run", true),
		chromedp.Flag("safebrowsing-disable-auto-update", true),
	)

	// Create a new context with the allocator options.
	allocCtx, cancelAlloc := chromedp.NewExecAllocator(context.Background(), opts...)
	defer cancelAlloc()

	// ★★★ 最終診断 ★★★
	// Re-enable verbose logging to capture Chrome's startup messages and potential crash logs.
	taskCtx, cancelTask := chromedp.NewContext(
		allocCtx,
		chromedp.WithDebugf(log.Printf),
	)
	defer cancelTask()

	// Navigate to Google and get the page title.
	var title string
	log.Println("Navigating to Google...")
	err := chromedp.Run(taskCtx,
		chromedp.Navigate(`https://www.google.com`),
		chromedp.Title(&title),
	)

	if err != nil {
		log.Printf("Chromedp execution failed: %v", err)
		return "", fmt.Errorf("failed to navigate and get title: %w", err)
	}

	log.Printf("Successfully navigated to Google. Page title: %s", title)
	return fmt.Sprintf("Successfully got title: %s", title), nil
}

func main() {
	lambda.Start(HandleRequest)
}

