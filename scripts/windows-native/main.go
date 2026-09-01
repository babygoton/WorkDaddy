//go:build windows

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const (
	profileCN = "workbuddy-cn"
	profileAI = "workbuddy-ai"

	exitFailure          = 4
	exitElevated         = 5
	exitWorkBuddyRunning = 10
	exitAccessDenied     = 11
	exitIdentityMismatch = 12
	exitUsage            = 20

	processTerminate               = 0x0001
	processQueryLimitedInformation = 0x1000
	synchronize                    = 0x00100000
	tokenQuery                     = 0x0008
	tokenElevation                 = 20 // TokenElevation
	th32csSnapProcess              = 0x00000002
	maxPath                        = 260
	infinite                       = 0xffffffff
	waitObject0                    = 0
	errorAlreadyExists             = 183
	mbOK                           = 0x00000000
	mbIconWarning                  = 0x00000030
	mbIconError                    = 0x00000010
	mbRetryCancel                  = 0x00000005
	idRetry                        = 4
)

var (
	kernel32                      = syscall.NewLazyDLL("kernel32.dll")
	advapi32                      = syscall.NewLazyDLL("advapi32.dll")
	user32                        = syscall.NewLazyDLL("user32.dll")
	versionDLL                    = syscall.NewLazyDLL("version.dll")
	procCreateMutexW              = kernel32.NewProc("CreateMutexW")
	procGetCurrentProcess         = kernel32.NewProc("GetCurrentProcess")
	procOpenProcessToken          = advapi32.NewProc("OpenProcessToken")
	procGetTokenInformation       = advapi32.NewProc("GetTokenInformation")
	procCreateToolhelp32Snapshot  = kernel32.NewProc("CreateToolhelp32Snapshot")
	procProcess32FirstW           = kernel32.NewProc("Process32FirstW")
	procProcess32NextW            = kernel32.NewProc("Process32NextW")
	procOpenProcess               = kernel32.NewProc("OpenProcess")
	procQueryFullProcessImageName = kernel32.NewProc("QueryFullProcessImageNameW")
	procTerminateProcess          = kernel32.NewProc("TerminateProcess")
	procWaitForSingleObject       = kernel32.NewProc("WaitForSingleObject")
	procMessageBoxW               = user32.NewProc("MessageBoxW")
	procGetFileVersionInfoSizeW   = versionDLL.NewProc("GetFileVersionInfoSizeW")
	procGetFileVersionInfoW       = versionDLL.NewProc("GetFileVersionInfoW")
	procVerQueryValueW            = versionDLL.NewProc("VerQueryValueW")
)

type processEntry32 struct {
	Size              uint32
	Usage             uint32
	ProcessID         uint32
	DefaultHeapID     uintptr
	ModuleID          uint32
	Threads           uint32
	ParentProcessID   uint32
	PriorityClassBase int32
	Flags             uint32
	ExeFile           [maxPath]uint16
}

type processRecord struct {
	PID       uint32 `json:"pid"`
	Name      string `json:"name"`
	Path      string `json:"path,omitempty"`
	ParentPID uint32 `json:"-"`
}

type lockOwner struct {
	PID int `json:"pid"`
}

type workBuddyTarget struct {
	ProfileID    string   `json:"profileId"`
	ClientType   string   `json:"clientType"`
	Binary       string   `json:"binary"`
	Version      string   `json:"version"`
	ProcessName  string   `json:"processName"`
	ProcessNames []string `json:"processNames"`
}

type vsFixedFileInfo struct {
	Signature        uint32
	StructVersion    uint32
	FileVersionMS    uint32
	FileVersionLS    uint32
	ProductVersionMS uint32
	ProductVersionLS uint32
	FileFlagsMask    uint32
	FileFlags        uint32
	FileOS           uint32
	FileType         uint32
	FileSubtype      uint32
	FileDateMS       uint32
	FileDateLS       uint32
}

func utf16Ptr(value string) *uint16 {
	ptr, err := syscall.UTF16PtrFromString(value)
	if err != nil {
		panic(err)
	}
	return ptr
}

func messageBox(title, message string, flags uintptr) int {
	result, _, _ := procMessageBoxW.Call(0, uintptr(unsafe.Pointer(utf16Ptr(message))), uintptr(unsafe.Pointer(utf16Ptr(title))), flags)
	return int(result)
}

func fileVersion(binary string) string {
	name := utf16Ptr(binary)
	var ignored uint32
	size, _, _ := procGetFileVersionInfoSizeW.Call(uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(&ignored)))
	if size == 0 || size > 16*1024*1024 {
		return ""
	}
	buffer := make([]byte, size)
	ok, _, _ := procGetFileVersionInfoW.Call(
		uintptr(unsafe.Pointer(name)), 0, size, uintptr(unsafe.Pointer(&buffer[0])),
	)
	if ok == 0 {
		return ""
	}
	root := utf16Ptr("\\")
	var fixed *vsFixedFileInfo
	var fixedSize uint32
	ok, _, _ = procVerQueryValueW.Call(
		uintptr(unsafe.Pointer(&buffer[0])), uintptr(unsafe.Pointer(root)),
		uintptr(unsafe.Pointer(&fixed)), uintptr(unsafe.Pointer(&fixedSize)),
	)
	if ok == 0 || fixed == nil || fixedSize < uint32(unsafe.Sizeof(*fixed)) || fixed.Signature != 0xFEEF04BD {
		return ""
	}
	return fmt.Sprintf("%d.%d.%d.%d",
		fixed.FileVersionMS>>16, fixed.FileVersionMS&0xffff,
		fixed.FileVersionLS>>16, fixed.FileVersionLS&0xffff)
}

func isElevated() (bool, error) {
	current, _, _ := procGetCurrentProcess.Call()
	var token syscall.Handle
	result, _, callErr := procOpenProcessToken.Call(current, tokenQuery, uintptr(unsafe.Pointer(&token)))
	if result == 0 {
		return false, callErr
	}
	defer syscall.CloseHandle(token)
	var elevation uint32
	var returned uint32
	result, _, callErr = procGetTokenInformation.Call(
		uintptr(token), tokenElevation, uintptr(unsafe.Pointer(&elevation)), unsafe.Sizeof(elevation), uintptr(unsafe.Pointer(&returned)),
	)
	if result == 0 {
		return false, callErr
	}
	return elevation != 0, nil
}

func acquireMutex(profile string) (syscall.Handle, bool, error) {
	name := "Local\\WorkDaddyLauncher-" + profile
	handle, _, callErr := procCreateMutexW.Call(0, 0, uintptr(unsafe.Pointer(utf16Ptr(name))))
	if handle == 0 {
		return 0, false, callErr
	}
	alreadyExists := errors.Is(callErr, syscall.Errno(errorAlreadyExists))
	return syscall.Handle(handle), alreadyExists, nil
}

func executableDir() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(exe)
	if err == nil {
		exe = resolved
	}
	return filepath.Dir(exe), nil
}

func normalizeProfile(profile string) string {
	if strings.EqualFold(strings.TrimSpace(profile), profileAI) {
		return profileAI
	}
	return profileCN
}

func readProfile(appDir string) string {
	if value := argumentValue("--profile"); value != "" {
		return normalizeProfile(value)
	}
	data, err := os.ReadFile(filepath.Join(appDir, "scripts", "profile-id.txt"))
	if err == nil {
		return normalizeProfile(string(data))
	}
	return profileCN
}

func argumentValue(name string) string {
	for index, arg := range os.Args[1:] {
		if arg == name && index+2 <= len(os.Args[1:]) {
			return os.Args[index+2]
		}
		if strings.HasPrefix(arg, name+"=") {
			return strings.TrimPrefix(arg, name+"=")
		}
	}
	return ""
}

func hasArgument(name string) bool {
	for _, arg := range os.Args[1:] {
		if arg == name {
			return true
		}
	}
	return false
}

func dataDir(profile string) (string, error) {
	root := os.Getenv("APPDATA")
	if root == "" {
		return "", errors.New("APPDATA is not available")
	}
	root = filepath.Join(root, "WorkDaddy")
	if profile == profileAI {
		return filepath.Join(root, "profiles", profileAI), nil
	}
	return root, nil
}

func productName(profile string) string {
	if profile == profileAI {
		return "WorkDaddy AI"
	}
	return "WorkDaddy"
}

func configuredTarget(profile string) workBuddyTarget {
	dir, err := dataDir(profile)
	if err != nil {
		return workBuddyTarget{}
	}
	data, err := os.ReadFile(filepath.Join(dir, "workbuddy-target.json"))
	if err != nil {
		return workBuddyTarget{}
	}
	var target workBuddyTarget
	if json.Unmarshal(data, &target) != nil || !strings.EqualFold(target.ProfileID, profile) {
		return workBuddyTarget{}
	}
	configuredBinary := strings.TrimSpace(target.Binary)
	processNames := target.ProcessNames
	if len(processNames) == 0 && strings.TrimSpace(target.ProcessName) != "" {
		processNames = []string{target.ProcessName}
	}
	if !filepath.IsAbs(configuredBinary) || len(processNames) == 0 || len(processNames) > 4 {
		return workBuddyTarget{}
	}
	selectedName := filepath.Base(configuredBinary)
	hasSelectedName := false
	for index, name := range processNames {
		name = strings.TrimSpace(name)
		if name == "" || !strings.EqualFold(name, filepath.Base(name)) || !strings.EqualFold(filepath.Ext(name), ".exe") {
			return workBuddyTarget{}
		}
		processNames[index] = name
		if strings.EqualFold(name, selectedName) {
			hasSelectedName = true
		}
	}
	if !hasSelectedName {
		return workBuddyTarget{}
	}
	target.Binary = filepath.Clean(configuredBinary)
	target.ProcessNames = processNames
	return target
}

func workBuddyImage(profile string) string {
	if target := configuredTarget(profile); len(target.ProcessNames) > 0 {
		return target.ProcessNames[0]
	}
	if profile == profileAI {
		return "WorkBuddyAI.exe"
	}
	return "WorkBuddy.exe"
}

func processNamesForBinary(binary string) []string {
	selected := filepath.Base(binary)
	names := []string{selected}
	stem := strings.TrimSuffix(selected, filepath.Ext(selected))
	lower := strings.ToLower(stem)
	for _, separator := range []string{"-", "_", " "} {
		prefix := "workbuddy" + separator
		if !strings.HasPrefix(lower, prefix) {
			continue
		}
		parts := strings.FieldsFunc(stem[len(prefix):], func(r rune) bool { return r == '-' || r == '_' || r == ' ' })
		suffix := ""
		for _, part := range parts {
			if part != "" {
				suffix += strings.ToUpper(part[:1]) + strings.ToLower(part[1:])
			}
		}
		if suffix != "" {
			names = append(names, "WorkBuddy"+suffix+".exe")
		}
		break
	}
	return names
}

func targetForBinary(profile, binary string) workBuddyTarget {
	binary = strings.TrimSpace(binary)
	if (profile != profileCN && profile != profileAI) || !filepath.IsAbs(binary) ||
		!strings.EqualFold(filepath.Ext(binary), ".exe") || strings.ContainsAny(binary, "\r\n") {
		return workBuddyTarget{}
	}
	info, err := os.Stat(binary)
	if err != nil || info.IsDir() {
		return workBuddyTarget{}
	}
	return workBuddyTarget{ProfileID: profile, Binary: filepath.Clean(binary), ProcessNames: processNamesForBinary(binary)}
}

func enumerateProcesses() ([]processRecord, error) {
	snapshot, _, callErr := procCreateToolhelp32Snapshot.Call(th32csSnapProcess, 0)
	if snapshot == uintptr(syscall.InvalidHandle) {
		return nil, callErr
	}
	defer syscall.CloseHandle(syscall.Handle(snapshot))

	entry := processEntry32{Size: uint32(unsafe.Sizeof(processEntry32{}))}
	result, _, callErr := procProcess32FirstW.Call(snapshot, uintptr(unsafe.Pointer(&entry)))
	if result == 0 {
		return nil, callErr
	}
	var records []processRecord
	for {
		name := syscall.UTF16ToString(entry.ExeFile[:])
		records = append(records, processRecord{
			PID: entry.ProcessID, Name: name, Path: queryProcessPath(entry.ProcessID), ParentPID: entry.ParentProcessID,
		})
		entry.Size = uint32(unsafe.Sizeof(processEntry32{}))
		result, _, _ = procProcess32NextW.Call(snapshot, uintptr(unsafe.Pointer(&entry)))
		if result == 0 {
			break
		}
	}
	return records, nil
}

func openProcess(pid uint32, access uint32) (syscall.Handle, error) {
	handle, _, callErr := procOpenProcess.Call(uintptr(access), 0, uintptr(pid))
	if handle == 0 {
		return 0, callErr
	}
	return syscall.Handle(handle), nil
}

func queryProcessPath(pid uint32) string {
	handle, err := openProcess(pid, processQueryLimitedInformation)
	if err != nil {
		return ""
	}
	defer syscall.CloseHandle(handle)
	buffer := make([]uint16, 32768)
	size := uint32(len(buffer))
	result, _, _ := procQueryFullProcessImageName.Call(
		uintptr(handle), 0, uintptr(unsafe.Pointer(&buffer[0])), uintptr(unsafe.Pointer(&size)),
	)
	if result == 0 || size == 0 {
		return ""
	}
	return syscall.UTF16ToString(buffer[:size])
}

func matchingWorkBuddyProcessesForTarget(profile string, target workBuddyTarget) ([]processRecord, error) {
	records, err := enumerateProcesses()
	if err != nil {
		return nil, err
	}
	expectedNames := []string{workBuddyImage(profile)}
	if len(target.ProcessNames) > 0 {
		expectedNames = target.ProcessNames
	}
	matched := make([]processRecord, 0)
	for _, record := range records {
		nameMatches := false
		for _, expected := range expectedNames {
			if strings.EqualFold(record.Name, expected) {
				nameMatches = true
				break
			}
		}
		pathMatches := target.Binary == "" || (record.Path != "" &&
			samePath(filepath.Dir(record.Path), filepath.Dir(target.Binary)) &&
			strings.EqualFold(filepath.Base(record.Path), record.Name))
		if nameMatches && pathMatches {
			matched = append(matched, record)
		}
	}
	return matched, nil
}

func matchingWorkBuddyProcesses(profile string) ([]processRecord, error) {
	return matchingWorkBuddyProcessesForTarget(profile, configuredTarget(profile))
}

func samePath(left, right string) bool {
	return strings.EqualFold(filepath.Clean(left), filepath.Clean(right))
}

func readPID(path string) int {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(string(data)))
	return pid
}

func readLockPID(path string) int {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	var owner lockOwner
	if json.Unmarshal(data, &owner) != nil {
		return 0
	}
	return owner.PID
}

func terminateExactProcess(pid int, expectedPath string, label string) (bool, int, error) {
	if pid <= 0 {
		return false, 0, nil
	}
	actual := queryProcessPath(uint32(pid))
	if actual == "" {
		// A process can exit between reading the PID file and querying it.
		handle, err := openProcess(uint32(pid), synchronize)
		if err != nil {
			if errors.Is(err, syscall.Errno(87)) { // ERROR_INVALID_PARAMETER: PID no longer exists.
				return false, 0, nil
			}
			if errors.Is(err, syscall.ERROR_ACCESS_DENIED) {
				return false, exitAccessDenied, fmt.Errorf("PID %d cannot be inspected at standard privilege", pid)
			}
			return false, exitFailure, err
		}
		waitResult, _, _ := procWaitForSingleObject.Call(uintptr(handle), 2000)
		syscall.CloseHandle(handle)
		if waitResult == waitObject0 {
			return false, 0, nil
		}
		return false, exitIdentityMismatch, fmt.Errorf("PID %d %s executable path is unavailable", pid, label)
	}
	if !samePath(actual, expectedPath) {
		return false, exitIdentityMismatch, fmt.Errorf("PID %d is %s, expected %s", pid, actual, expectedPath)
	}
	handle, err := openProcess(uint32(pid), processTerminate|synchronize|processQueryLimitedInformation)
	if err != nil {
		if errors.Is(err, syscall.ERROR_ACCESS_DENIED) {
			return false, exitAccessDenied, fmt.Errorf("PID %d %s cannot be terminated at standard privilege", pid, label)
		}
		return false, exitFailure, err
	}
	defer syscall.CloseHandle(handle)
	result, _, callErr := procTerminateProcess.Call(uintptr(handle), 0)
	if result == 0 {
		if errors.Is(callErr, syscall.ERROR_ACCESS_DENIED) {
			return false, exitAccessDenied, fmt.Errorf("PID %d %s cannot be terminated at standard privilege", pid, label)
		}
		return false, exitFailure, callErr
	}
	waitResult, _, callErr := procWaitForSingleObject.Call(uintptr(handle), 15000)
	if waitResult != waitObject0 {
		return false, exitFailure, fmt.Errorf("PID %d did not exit: %v", pid, callErr)
	}
	return true, 0, nil
}

func terminateExactNode(pid int, expectedNode string) (bool, int, error) {
	return terminateExactProcess(pid, expectedNode, "node")
}

func stopInstalledLauncher(appDir string) int {
	expectedLauncher := filepath.Join(appDir, "WorkDaddyLauncher.exe")
	records, err := enumerateProcesses()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return exitFailure
	}
	matches := make([]processRecord, 0, 1)
	for _, record := range records {
		// The --stop-lifecycle helper is itself WorkDaddyLauncher.exe from the
		// target directory. Exclude only this helper; every other match remains
		// subject to the single-process fail-closed boundary below.
		if record.PID == uint32(os.Getpid()) {
			continue
		}
		if strings.EqualFold(record.Name, "WorkDaddyLauncher.exe") && samePath(record.Path, expectedLauncher) {
			matches = append(matches, record)
		}
	}
	if len(matches) > 1 {
		fmt.Fprintln(os.Stderr, "发现多个当前安装目录的 WorkDaddyLauncher 进程，已拒绝批量结束")
		return exitIdentityMismatch
	}
	if len(matches) == 0 {
		return 0
	}
	_, code, stopErr := terminateExactProcess(int(matches[0].PID), expectedLauncher, "launcher")
	if stopErr != nil {
		fmt.Fprintln(os.Stderr, stopErr)
		return code
	}
	return 0
}

func uniqueRunningWorkBuddyPath(profile string, matches []processRecord) (string, error) {
	paths := make([]string, 0, len(matches))
	for _, match := range matches {
		if strings.TrimSpace(match.Path) == "" {
			return "", fmt.Errorf("PID %d WorkBuddy executable path is unavailable", match.PID)
		}
		found := false
		for _, existing := range paths {
			if samePath(existing, match.Path) {
				found = true
				break
			}
		}
		if !found {
			paths = append(paths, match.Path)
		}
	}
	if len(paths) != 1 {
		return "", fmt.Errorf("发现多个 %s 安装目录中的 WorkBuddy 进程，已拒绝批量结束", productName(profile))
	}
	return paths[0], nil
}

func terminateWorkBuddyTarget(profile string, target workBuddyTarget) int {
	elevated, err := isElevated()
	if err != nil {
		fmt.Fprintln(os.Stderr, "cannot determine helper privilege:", err)
		return exitFailure
	}
	if elevated {
		fmt.Fprintln(os.Stderr, "WorkBuddy termination requires standard user privilege")
		return exitAccessDenied
	}
	matches, err := matchingWorkBuddyProcessesForTarget(profile, target)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return exitFailure
	}
	if len(matches) == 0 {
		return 0
	}
	expectedPath, err := uniqueRunningWorkBuddyPath(profile, matches)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return exitIdentityMismatch
	}
	for _, match := range matches {
		if !samePath(match.Path, expectedPath) {
			continue
		}
		if _, code, stopErr := terminateExactProcess(int(match.PID), expectedPath, "WorkBuddy"); stopErr != nil {
			fmt.Fprintln(os.Stderr, stopErr)
			return code
		}
	}
	return 0
}

func terminateWorkBuddy(profile string) int {
	return terminateWorkBuddyTarget(profile, configuredTarget(profile))
}

// recoverWatchdogPID uses the process tree only as a recovery proof when the
// user-writable watchdog.pid disappeared during an install/update race. The
// daemon PID comes from the profile lock file and both processes must use the
// exact bundled Node executable. Any ambiguity remains fail-closed.
func recoverWatchdogPID(records []processRecord, expectedNode string, daemonPID int) (int, error) {
	if daemonPID <= 0 {
		return 0, nil
	}
	var daemon *processRecord
	for index := range records {
		record := &records[index]
		if record.PID == uint32(daemonPID) && samePath(record.Path, expectedNode) {
			if daemon != nil {
				return 0, fmt.Errorf("daemon PID %d appears more than once", daemonPID)
			}
			daemon = record
		}
	}
	if daemon == nil || daemon.ParentPID == 0 {
		return 0, nil
	}
	candidates := make([]processRecord, 0, 1)
	for _, record := range records {
		if record.PID == daemon.ParentPID && samePath(record.Path, expectedNode) {
			candidates = append(candidates, record)
		}
	}
	if len(candidates) != 1 {
		if len(candidates) > 1 {
			return 0, fmt.Errorf("daemon PID %d has multiple bundled Node parents", daemonPID)
		}
		return 0, nil
	}
	candidate := candidates[0]
	if strings.TrimSpace(candidate.Path) == "" {
		return 0, nil
	}
	return int(candidate.PID), nil
}

func stopLifecycle(profile, appDir string) int {
	dir, err := dataDir(profile)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return exitFailure
	}
	expectedNode := filepath.Join(appDir, "scripts", "runtime", "node", "node.exe")
	watchdogPath := filepath.Join(dir, "watchdog.pid")
	watchdogPID := readPID(watchdogPath)
	watchdogPresent := false
	if _, statErr := os.Stat(watchdogPath); statErr == nil {
		watchdogPresent = true
	} else if !os.IsNotExist(statErr) {
		fmt.Fprintln(os.Stderr, statErr)
		return exitFailure
	}
	if watchdogPresent && watchdogPID <= 0 {
		fmt.Fprintln(os.Stderr, "watchdog.pid 内容无效")
		return exitIdentityMismatch
	}
	daemonPID := readLockPID(filepath.Join(dir, ".daemon.lock"))
	if !watchdogPresent && daemonPID > 0 {
		records, enumerateErr := enumerateProcesses()
		if enumerateErr != nil {
			fmt.Fprintln(os.Stderr, enumerateErr)
			return exitFailure
		}
		recovered, recoverErr := recoverWatchdogPID(records, expectedNode, daemonPID)
		if recoverErr != nil {
			fmt.Fprintln(os.Stderr, recoverErr)
			return exitIdentityMismatch
		}
		if recovered > 0 {
			watchdogPID = recovered
			watchdogPresent = true
		} else {
			for _, record := range records {
				if record.PID == uint32(daemonPID) && samePath(record.Path, expectedNode) {
					fmt.Fprintln(os.Stderr, "watchdog.pid 缺失且无法证明当前 daemon 的唯一 watchdog，已拒绝只停止 daemon")
					return exitIdentityMismatch
				}
			}
		}
	}
	pidFiles := []struct {
		path string
		pid  int
	}{
		{watchdogPath, watchdogPID},
		{filepath.Join(dir, ".daemon.lock"), daemonPID},
	}
	seen := map[int]bool{}
	for _, candidate := range pidFiles {
		if candidate.pid <= 0 || seen[candidate.pid] {
			continue
		}
		seen[candidate.pid] = true
		_, code, stopErr := terminateExactNode(candidate.pid, expectedNode)
		if stopErr != nil {
			fmt.Fprintln(os.Stderr, stopErr)
			return code
		}
	}
	for _, candidate := range pidFiles {
		if candidate.path != "" {
			_ = os.Remove(candidate.path)
		}
	}
	if code := stopInstalledLauncher(appDir); code != 0 {
		return code
	}
	return 0
}

func appendLog(dir string, args ...any) *os.File {
	_ = os.MkdirAll(dir, 0700)
	file, err := os.OpenFile(filepath.Join(dir, "native-launcher.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return nil
	}
	fmt.Fprintln(file, append([]any{time.Now().Format(time.RFC3339)}, args...)...)
	return file
}

func runNodeLauncher(appDir, profile string) int {
	dir, err := dataDir(profile)
	if err != nil {
		messageBox(productName(profile), "无法确定 WorkDaddy 数据目录："+err.Error(), mbOK|mbIconError)
		return exitFailure
	}
	logFile := appendLog(dir, "launch", "profile="+profile, "appDir="+appDir)
	if logFile != nil {
		defer logFile.Close()
	}
	node := filepath.Join(appDir, "scripts", "runtime", "node", "node.exe")
	launcher := filepath.Join(appDir, "scripts", "win-launcher.js")
	if _, err := os.Stat(node); err != nil {
		messageBox(productName(profile), "安装文件不完整：找不到内置 Node.js。请重新安装。", mbOK|mbIconError)
		return exitFailure
	}
	if _, err := os.Stat(launcher); err != nil {
		messageBox(productName(profile), "安装文件不完整：找不到启动脚本。请重新安装。", mbOK|mbIconError)
		return exitFailure
	}

	for {
		cmd := exec.Command(node, launcher)
		cmd.Dir = filepath.Join(appDir, "scripts")
		cmd.Env = append(os.Environ(), "WBSWITCH_NATIVE_LAUNCHER=1", "WBSWITCH_PROFILE="+profile, "WBSWITCH_APP_DIR="+appDir)
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		if logFile != nil {
			cmd.Stdout = io.MultiWriter(logFile)
			cmd.Stderr = io.MultiWriter(logFile)
		}
		err := cmd.Run()
		code := 0
		if err != nil {
			var exitErr *exec.ExitError
			if errors.As(err, &exitErr) {
				code = exitErr.ExitCode()
			} else {
				code = exitFailure
			}
		}
		if code == exitWorkBuddyRunning {
			choice := messageBox(productName(profile), "WorkBuddy 已经打开，但没有启用 WorkDaddy 所需的调试端口。\n\n请完全退出 WorkBuddy，然后点击“重试”。", mbRetryCancel|mbIconWarning)
			if choice == idRetry {
				continue
			}
			return 0
		}
		if code != 0 {
			messageBox(productName(profile), fmt.Sprintf("启动失败（错误码 %d）。\n\n详细信息已写入 native-launcher.log。", code), mbOK|mbIconError)
		}
		return code
	}
}

func helperMain(appDir, profile string) (bool, int) {
	if hasArgument("--target-info") {
		target := configuredTarget(profile)
		output := argumentValue("--output")
		if target.Binary == "" || output == "" || !filepath.IsAbs(output) || strings.ContainsAny(target.Binary, "\r\n") {
			return true, exitFailure
		}
		version := strings.TrimSpace(target.Version)
		if version == "" {
			version = fileVersion(target.Binary)
		}
		clientType := strings.TrimSpace(target.ClientType)
		if strings.ContainsAny(version, "\r\n") || strings.ContainsAny(clientType, "\r\n") {
			return true, exitFailure
		}
		if os.WriteFile(output, []byte(target.Binary+"\r\n"+version+"\r\n"+clientType+"\r\n"), 0600) != nil {
			return true, exitFailure
		}
		return true, 0
	}
	if hasArgument("--file-version") {
		binary := argumentValue("--binary")
		if binary == "" || !filepath.IsAbs(binary) {
			return true, exitUsage
		}
		version := fileVersion(binary)
		if version == "" {
			return true, exitFailure
		}
		fmt.Fprintln(os.Stdout, version)
		return true, 0
	}
	if hasArgument("--check-workbuddy") {
		target := configuredTarget(profile)
		if binary := argumentValue("--binary"); binary != "" {
			target = targetForBinary(profile, binary)
			if target.Binary == "" {
				return true, exitUsage
			}
		}
		matches, err := matchingWorkBuddyProcessesForTarget(profile, target)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return true, exitFailure
		}
		if len(matches) > 0 {
			return true, exitWorkBuddyRunning
		}
		return true, 0
	}
	if hasArgument("--list-workbuddy") {
		matches, err := matchingWorkBuddyProcesses(profile)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return true, exitFailure
		}
		_ = json.NewEncoder(os.Stdout).Encode(matches)
		return true, 0
	}
	if hasArgument("--terminate-workbuddy") {
		if binary := argumentValue("--binary"); binary != "" {
			target := targetForBinary(profile, binary)
			if target.Binary == "" {
				return true, exitUsage
			}
			return true, terminateWorkBuddyTarget(profile, target)
		}
		return true, terminateWorkBuddy(profile)
	}
	if hasArgument("--stop-lifecycle") {
		elevated, err := isElevated()
		if err != nil {
			fmt.Fprintln(os.Stderr, "cannot determine helper privilege:", err)
			return true, exitFailure
		}
		if elevated {
			fmt.Fprintln(os.Stderr, "lifecycle stop requires standard user privilege")
			return true, exitAccessDenied
		}
		targetApp := argumentValue("--app-dir")
		if targetApp == "" {
			targetApp = appDir
		}
		return true, stopLifecycle(profile, targetApp)
	}
	if hasArgument("--self-test") {
		elevated, err := isElevated()
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return true, exitFailure
		}
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"profile": profile, "appDir": appDir, "elevated": elevated})
		return true, 0
	}
	return false, 0
}

func main() {
	appDir, err := executableDir()
	if err != nil {
		os.Exit(exitFailure)
	}
	profile := readProfile(appDir)
	if handled, code := helperMain(appDir, profile); handled {
		os.Exit(code)
	}

	elevated, err := isElevated()
	if err != nil {
		messageBox(productName(profile), "无法确认当前 Windows 权限，已停止启动。", mbOK|mbIconError)
		os.Exit(exitFailure)
	}
	if elevated {
		messageBox(productName(profile), "请使用普通方式启动 WorkDaddy，不要选择“以管理员身份运行”。\n\nUAC 可以保持开启；正常双击快捷方式不会请求管理员权限。", mbOK|mbIconWarning)
		os.Exit(exitElevated)
	}

	mutex, alreadyRunning, err := acquireMutex(profile)
	if err != nil {
		messageBox(productName(profile), "无法创建启动锁："+err.Error(), mbOK|mbIconError)
		os.Exit(exitFailure)
	}
	defer syscall.CloseHandle(mutex)
	if alreadyRunning {
		os.Exit(0)
	}
	os.Exit(runNodeLauncher(appDir, profile))
}
