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
	// These flags are crucial for running in a containerized, headless environment.
	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		// The official Google Chrome RPM installs the binary here.
		chromedp.ExecPath("/opt/google/chrome/google-chrome"),
		chromedp.Flag("headless", true),
		chromedp.Flag("no-sandbox", true), // Most important flag for Lambda
		chromedp.Flag("disable-gpu", true),
		chromedp.Flag("disable-dev-shm-usage", true), // /dev/shm is limited in Lambda
		chromedp.Flag("single-process", true),       // Helps in resource-constrained environments
		chromedp.Flag("disable-setuid-sandbox", true),
		chromedp.Flag("window-size", "1920,1080"),
		// Using a common user agent can help avoid bot detection.
		chromedp.Flag("user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.102 Safari/537.36"),
	)

	// Create a new context with the allocator options.
	allocCtx, cancel := chromedp.NewExecAllocator(context.Background(), opts...)
	defer cancel()

	// Create a new chromedp context.
	taskCtx, cancel := chromedp.NewContext(allocCtx)
	defer cancel()

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

