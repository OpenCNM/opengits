package main

import (
	"os"

	"github.com/opengits/worker-sidecar/internal/daemon"
)

func main() {
	if err := daemon.Run(os.Args[1:]); err != nil {
		println("daemon run error:", err.Error())
		os.Exit(1)
	}
}
