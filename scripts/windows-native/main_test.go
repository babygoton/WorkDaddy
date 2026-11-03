//go:build windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStartupFailureMessagesPreserveFailureCategory(t *testing.T) {
	for _, item := range []struct {
		code int
		text string
	}{
		{3, "调试端口"}, {11, "权限"}, {12, "身份"}, {13, "保留"},
		{14, "异常退出"}, {15, "更新"}, {4, "启动失败"},
	} {
		message := startupFailureMessage(item.code)
		if !strings.Contains(message, item.text) || !strings.Contains(message, "native-launcher.log") {
			t.Fatalf("code %d lost category or log location: %s", item.code, message)
		}
		if strings.Contains(message, "管理员身份重试") {
			t.Fatal("startup guidance must not request privilege escalation")
		}
	}
}

func TestProcessNameDiffersRequiresPositiveMismatch(t *testing.T) {
	for _, test := range []struct {
		name string
		want bool
	}{
		{"svchost.exe", true},
		{"System", true},
		{"node.exe", false},
		{"NODE.EXE", false},
		{"", false},
	} {
		if got := processNameDiffers(test.name, `C:\WorkDaddy\scripts\runtime\node\node.exe`); got != test.want {
			t.Errorf("name %q: unrelated=%v, want %v", test.name, got, test.want)
		}
	}
	if processNameDiffers("node.exe", "") {
		t.Fatal("missing expected identity must stay fail-closed")
	}
}

func TestExactInspectionStillRejectsWrongPath(t *testing.T) {
	expectedPath := filepath.Join(t.TempDir(), filepath.Base(os.Args[0]))
	active, code, err := inspectExactProcess(os.Getpid(), expectedPath, "test")
	if active || code != exitIdentityMismatch || err == nil {
		t.Fatalf("wrong executable path accepted: active=%v code=%d err=%v", active, code, err)
	}
}

func TestProtectedMatchingProcessStillFailsClosed(t *testing.T) {
	active, code, err := inspectExactProcess(4, `C:\Windows\System32\System`, "test")
	if active || code != exitAccessDenied || err == nil {
		t.Fatalf("protected matching name accepted: active=%v code=%d err=%v", active, code, err)
	}
}

func TestLifecycleIgnoresRecycledSystemPID(t *testing.T) {
	// PID 4 is the protected System process, never a WorkDaddy Node process.
	// Exercise the real Windows access-denied inspection without terminating it.
	t.Setenv("APPDATA", t.TempDir())
	appDir := t.TempDir()
	dir, err := dataDir(profileCN)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{
		"watchdog.pid":          "4",
		".daemon.lock":          `{"pid":4}`,
		"account-data-sentinel": "preserve",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if code := stopLifecycle(profileCN, appDir, false); code != 0 {
		t.Fatalf("stale PID for protected unrelated process blocks cleanup: %d", code)
	}
	for _, name := range []string{"watchdog.pid", ".daemon.lock"} {
		if _, err := os.Stat(filepath.Join(dir, name)); !os.IsNotExist(err) {
			t.Fatalf("stale %s remains: %v", name, err)
		}
	}
	if data, err := os.ReadFile(filepath.Join(dir, "account-data-sentinel")); err != nil || string(data) != "preserve" {
		t.Fatalf("unrelated data changed: %v", err)
	}
	if records, err := enumerateProcesses(); err != nil {
		t.Fatal(err)
	} else {
		for _, record := range records {
			if record.PID == 4 {
				return
			}
		}
		t.Fatal("System process disappeared")
	}
}

func TestLifecycleIgnoresRecycledReadablePID(t *testing.T) {
	t.Setenv("APPDATA", t.TempDir())
	dir, err := dataDir(profileCodeCN)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	// The test executable has a readable path but is not bundled Node.
	if err := os.WriteFile(filepath.Join(dir, ".daemon.lock"), []byte(fmt.Sprintf(`{"pid":%d}`, os.Getpid())), 0600); err != nil {
		t.Fatal(err)
	}
	if code := stopLifecycle(profileCodeCN, t.TempDir(), false); code != 0 {
		t.Fatalf("recycled PID for unrelated readable process blocks cleanup: %d", code)
	}
	if _, err := os.Stat(filepath.Join(dir, ".daemon.lock")); !os.IsNotExist(err) {
		t.Fatalf("stale lock remains: %v", err)
	}
}
