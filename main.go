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

	// Create a new context with a generous timeout.
	mainCtx, cancel := context.WithTimeout(requestCtx, 80*time.Second)
	defer cancel()

	// Set up options for headless Chrome execution in Lambda.
	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.ExecPath("/opt/chromium"), // The path inside the container
		chromedp.Flag("headless", true),
		chromedp.Flag("no-sandbox", true),
		chromedp.Flag("single-process", true),
		chromedp.Flag("disable-gpu", true),
		chromedp.Flag("disable-dev-shm-usage", true),
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

