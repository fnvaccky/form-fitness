// Renders preview-only JSON through the same contextual Go HTML engine as Auth templates.
// No network, SMTP or authentication operation is available in this harness.
package main

import (
	"encoding/json"
	"fmt"
	"html/template"
	"os"
	texttemplate "text/template"
)

func main() {
	var input struct {
		Template string         `json:"template"`
		Data     map[string]any `json:"data"`
		Format   string         `json:"format"`
	}
	if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	var err error
	if input.Format == "text" {
		var parsed *texttemplate.Template
		parsed, err = texttemplate.New("preview").Option("missingkey=zero").Parse(input.Template)
		if err == nil {
			err = parsed.Execute(os.Stdout, input.Data)
		}
	} else {
		var parsed *template.Template
		parsed, err = template.New("preview").Option("missingkey=zero").Parse(input.Template)
		if err == nil {
			err = parsed.Execute(os.Stdout, input.Data)
		}
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
