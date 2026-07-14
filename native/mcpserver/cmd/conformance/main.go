package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func fail(format string, values ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", values...)
	os.Exit(1)
}

func main() {
	sidecar := flag.String("sidecar", "", "path to ExploreBetterMcp.exe")
	profile := flag.String("profile", "", "AI Bridge profile ID")
	manifest := flag.String("manifest", "", "AI Bridge manifest path")
	expectedTools := flag.Int("expected-tools", 0, "expected number of profile-permitted tools")
	flag.Parse()
	if *sidecar == "" || *profile == "" || *manifest == "" {
		fail("--sidecar, --profile, and --manifest are required")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	command := exec.Command(*sidecar, "--profile", *profile, "--manifest", *manifest)
	command.Stderr = os.Stderr
	client := mcp.NewClient(&mcp.Implementation{Name: "explore-better-official-sdk-verifier", Version: "1"}, nil)
	session, err := client.Connect(ctx, &mcp.CommandTransport{Command: command}, nil)
	if err != nil {
		fail("official SDK initialize failed: %v", err)
	}
	defer session.Close()

	tools, err := session.ListTools(ctx, nil)
	if err != nil || len(tools.Tools) == 0 || (*expectedTools > 0 && len(tools.Tools) != *expectedTools) {
		fail("official SDK tools/list failed: count=%d error=%v", len(tools.Tools), err)
	}
	resources, err := session.ListResources(ctx, nil)
	if err != nil || len(resources.Resources) != 3 {
		fail("official SDK resources/list failed: count=%d error=%v", len(resources.Resources), err)
	}
	templates, err := session.ListResourceTemplates(ctx, nil)
	if err != nil || len(templates.ResourceTemplates) != 2 {
		fail("official SDK resource templates failed: count=%d error=%v", len(templates.ResourceTemplates), err)
	}
	prompts, err := session.ListPrompts(ctx, nil)
	if err != nil || len(prompts.Prompts) != 4 {
		fail("official SDK prompts/list failed: count=%d error=%v", len(prompts.Prompts), err)
	}

	result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "get_context", Arguments: map[string]any{}})
	if err != nil || result.IsError || result.StructuredContent == nil {
		fail("official SDK get_context failed: isError=%v error=%v", result != nil && result.IsError, err)
	}
	manual, err := session.ReadResource(ctx, &mcp.ReadResourceParams{URI: "explore-better://manual/ai-bridge"})
	if err != nil || len(manual.Contents) != 1 || manual.Contents[0].MIMEType != "text/markdown" || len(manual.Contents[0].Text) < 200 {
		fail("official SDK manual resource failed: contents=%d error=%v", len(manual.Contents), err)
	}

	output := map[string]any{
		"ok": true, "tools": len(tools.Tools), "resources": len(resources.Resources),
		"resourceTemplates": len(templates.ResourceTemplates), "prompts": len(prompts.Prompts),
		"manualMimeType": manual.Contents[0].MIMEType,
	}
	data, _ := json.Marshal(output)
	fmt.Println(string(data))
}
