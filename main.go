package main

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/aws/aws-lambda-go/lambda"
	"github.com/chromedp/chromedp"
)

// HandleRequest is the main entry point for the Lambda function.
func HandleRequest(requestCtx context.Context) (string, error) {
	log.Printf("Lambda function started")

	// Create a new context with a generous timeout. This will be the master context for the entire operation.
	// This ensures that even on a very slow cold start, chromedp has enough time to initialize Chrome.
	// The timeout is set to be slightly less than the Lambda function's overall timeout.
	mainCtx, cancel := context.WithTimeout(requestCtx, 80*time.Second)
	defer cancel()

	// Use a known-good, pre-compiled Chromium binary specifically for AWS Lambda.
	// All other flags are set for maximum compatibility in this environment.
	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.ExecPath("/opt/chromium"),
		chromedp.Flag("headless", true),
		chromedp.Flag("no-sandbox", true),
		chromedp.Flag("disable-gpu", true),
		chromedp.Flag("disable-dev-shm-usage", true),
		chromedp.Flag("single-process", true),
		chromedp.Flag("disable-setuid-sandbox", true),
		chromedp.Flag("user-data-dir", "/tmp/user-data"),
		chromedp.Flag("data-path", "/tmp/data-path"),
		chromedp.Flag("disk-cache-dir", "/tmp/cache-dir"),
		chromedp.Flag("homedir", "/tmp"),
		chromedp.Flag("disable-zygote", true),
		chromedp.Flag("disable-extensions", true),
		chromedp.Flag("disable-background-networking", true),
		chromedp.Flag("disable-sync", true),
		chromedp.Flag("no-first-run", true),
	)

	allocCtx, cancelAlloc := chromedp.NewExecAllocator(mainCtx, opts...)
	defer cancelAlloc()

	taskCtx, cancelTask := chromedp.NewContext(allocCtx)
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

