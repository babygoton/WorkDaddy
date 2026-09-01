#ifndef AppVersion
  #error AppVersion must be supplied by build-win-installer.ps1
#endif
#ifndef ProfileId
  #error ProfileId must be supplied by build-win-installer.ps1
#endif
#ifndef ProductName
  #error ProductName must be supplied by build-win-installer.ps1
#endif
#ifndef PackageName
  #error PackageName must be supplied by build-win-installer.ps1
#endif
#ifndef AppGuid
  #error AppGuid must be supplied by build-win-installer.ps1
#endif
#ifndef StageRoot
  #error StageRoot must be supplied by build-win-installer.ps1
#endif
#ifndef OutputDir
  #error OutputDir must be supplied by build-win-installer.ps1
#endif
#ifndef StartDescription
  #error StartDescription must be supplied by build-win-installer.ps1
#endif

#define AppUrl "https://github.com/babygoton/WorkDaddy"

[Setup]
AppId={#AppGuid}
AppName={#ProductName}
AppVersion={#AppVersion}
AppVerName={#ProductName} {#AppVersion}
AppPublisher={#ProductName} 团队
AppPublisherURL={#AppUrl}
AppSupportURL={#AppUrl}
AppUpdatesURL=https://github.com/babygoton/WorkDaddy/releases
DefaultDirName={localappdata}\Programs\{#ProductName}
DefaultGroupName={#ProductName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
Compression=lzma2/ultra64
SolidCompression=yes
OutputDir={#OutputDir}
OutputBaseFilename={#PackageName}-Setup-{#AppVersion}
SetupLogging=yes
CloseApplications=no
RestartApplications=no
RestartIfNeededByRun=no
MinVersion=10.0
UninstallDisplayName={#ProductName}

[Languages]
Name: "chinesesimplified"; MessagesFile: "ChineseSimplified.isl"

[Files]
Source: "{#StageRoot}\WorkDaddyLauncher.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageRoot}\WorkDaddyLauncher.exe"; Flags: dontcopy
Source: "{#StageRoot}\scripts\WorkDaddy.ico"; DestDir: "{app}\scripts"; DestName: "{#PackageName}-{#AppVersion}.ico"; Flags: ignoreversion
Source: "{#StageRoot}\scripts\*"; DestDir: "{app}\scripts"; Excludes: "runtime\node\*,WorkDaddy.ico"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StageRoot}\scripts\runtime\node\*"; DestDir: "{app}\scripts\runtime\node"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
Type: files; Name: "{app}\scripts\WorkDaddy.ico"
Type: files; Name: "{app}\scripts\WorkDaddy-*.ico"

[Icons]
Name: "{group}\{#ProductName}"; Filename: "{app}\WorkDaddyLauncher.exe"; WorkingDir: "{app}"; IconFilename: "{app}\scripts\{#PackageName}-{#AppVersion}.ico"
Name: "{userdesktop}\{#ProductName}"; Filename: "{app}\WorkDaddyLauncher.exe"; WorkingDir: "{app}"; IconFilename: "{app}\scripts\{#PackageName}-{#AppVersion}.ico"

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; ValueName: "WorkDaddy"; Flags: deletevalue
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; ValueName: "WorkDaddy AI"; Flags: deletevalue

[Run]
Filename: "{app}\WorkDaddyLauncher.exe"; Description: "{#StartDescription}"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent runasoriginaluser

[UninstallRun]
Filename: "{app}\WorkDaddyLauncher.exe"; Parameters: "--stop-lifecycle --profile ""{#ProfileId}"" --app-dir ""{app}"""; WorkingDir: "{app}"; Flags: runhidden waituntilterminated; RunOnceId: "StopWorkDaddyLifecycle"

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
var
  ClientPage: TInputFileWizardPage;
  ClientSourceLabel: TNewStaticText;
  ClientVersionLabel: TNewStaticText;
  UseDetectedButton: TNewButton;
  DetectedOfficialPath: String;
  SelectedWorkBuddyPath: String;
  SelectedWorkBuddyVersion: String;

function RunNativeHelper(const Mode: String; var ResultCode: Integer): Boolean;
var
  Parameters: String;
begin
  ExtractTemporaryFile('WorkDaddyLauncher.exe');
  Parameters := Mode + ' --profile "{#ProfileId}"';
  Result := ExecAsOriginalUser(
    ExpandConstant('{tmp}\WorkDaddyLauncher.exe'),
    Parameters,
    ExpandConstant('{tmp}'),
    SW_HIDE,
    ewWaitUntilTerminated,
    ResultCode
  );
end;

function ExpectedWorkBuddyName(): String;
begin
  if '{#ProfileId}' = 'workbuddy-ai' then
    Result := 'WorkBuddyAI.exe'
  else
    Result := 'WorkBuddy.exe';
end;

function UsableClientFile(const Candidate: String): Boolean;
begin
  Result := (Candidate <> '') and FileExists(Candidate) and
    (CompareText(ExtractFileExt(Candidate), '.exe') = 0);
end;

function OfficialClientFile(const Candidate: String): Boolean;
begin
  Result := UsableClientFile(Candidate) and
    (CompareText(ExtractFileName(Candidate), ExpectedWorkBuddyName()) = 0);
end;

function NextVersionComponent(const Version: String; var Offset: Integer): Integer;
var
  StartAt: Integer;
  SeparatorAt: Integer;
  Remaining: String;
begin
  if Offset > Length(Version) then
  begin
    Result := 0;
    exit;
  end;
  StartAt := Offset;
  Remaining := Copy(Version, StartAt, Length(Version) - StartAt + 1);
  SeparatorAt := Pos('.', Remaining);
  if SeparatorAt = 0 then
  begin
    Result := StrToIntDef(Remaining, 0);
    Offset := Length(Version) + 1;
  end
  else
  begin
    Result := StrToIntDef(Copy(Remaining, 1, SeparatorAt - 1), 0);
    Offset := StartAt + SeparatorAt;
  end;
end;

function CompareVersionStrings(const LeftVersion: String; const RightVersion: String): Integer;
var
  Index: Integer;
  LeftOffset: Integer;
  RightOffset: Integer;
  LeftPart: Integer;
  RightPart: Integer;
begin
  LeftOffset := 1;
  RightOffset := 1;
  Result := 0;
  for Index := 0 to 3 do
  begin
    LeftPart := NextVersionComponent(LeftVersion, LeftOffset);
    RightPart := NextVersionComponent(RightVersion, RightOffset);
    if LeftPart > RightPart then
    begin
      Result := 1;
      exit;
    end;
    if LeftPart < RightPart then
    begin
      Result := -1;
      exit;
    end;
  end;
end;

function CompareClientFileVersions(const LeftPath: String; const RightPath: String): Integer;
var
  LeftVersion: String;
  RightVersion: String;
begin
  LeftVersion := '';
  RightVersion := '';
  GetVersionNumbersString(LeftPath, LeftVersion);
  GetVersionNumbersString(RightPath, RightVersion);
  Result := CompareVersionStrings(LeftVersion, RightVersion);
end;

procedure ConsiderClientCandidate(const Candidate: String; var BestCandidate: String);
begin
  if not OfficialClientFile(Candidate) then
    exit;
  Log(Format('WorkDaddy installer candidate: %s (version comparison target: %s)', [Candidate, BestCandidate]));
  if (BestCandidate = '') or
    (CompareClientFileVersions(Candidate, BestCandidate) > 0) then
    BestCandidate := Candidate;
end;

function ExecutableFromDisplayIcon(const DisplayIcon: String): String;
var
  Value: String;
  Marker: Integer;
  Index: Integer;
begin
  Result := '';
  Value := Trim(DisplayIcon);
  if Value = '' then
    exit;
  if Value[1] = '"' then
  begin
    Delete(Value, 1, 1);
    Marker := Pos('"', Value);
    if Marker > 0 then
      Value := Copy(Value, 1, Marker - 1);
  end;
  Value := Trim(Value);
  Marker := 0;
  for Index := Length(Value) downto 1 do
  begin
    if Value[Index] = ',' then
    begin
      Marker := Index;
      break;
    end;
  end;
  if (Marker > 0) and
    (CompareText(ExtractFileExt(Copy(Value, 1, Marker - 1)), '.exe') = 0) then
    Value := Copy(Value, 1, Marker - 1);
  Result := Trim(Value);
end;

procedure ConsiderUninstallClients(const RootKey: Integer; const BaseKey: String;
  var BestCandidate: String);
var
  Names: TArrayOfString;
  Index: Integer;
  Key: String;
  Value: String;
  Candidate: String;
begin
  if not RegGetSubkeyNames(RootKey, BaseKey, Names) then
  begin
    Log(Format('WorkDaddy installer could not enumerate uninstall root %d', [RootKey]));
    exit;
  end;
  Log(Format('WorkDaddy installer scanning uninstall root %d (%d entries)', [RootKey, GetArrayLength(Names)]));
  for Index := 0 to GetArrayLength(Names) - 1 do
  begin
    Key := BaseKey + '\' + Names[Index];
    Candidate := '';
    if RegQueryStringValue(RootKey, Key, 'DisplayIcon', Value) then
    begin
      Candidate := ExecutableFromDisplayIcon(Value);
      if Pos(Lowercase(ExpectedWorkBuddyName()), Lowercase(Value)) > 0 then
      begin
        if FileExists(Candidate) then
          Log('WorkDaddy installer parsed uninstall DisplayIcon: ' + Candidate)
        else
          Log('WorkDaddy installer parsed missing uninstall DisplayIcon: ' + Candidate);
      end;
    end;
    if not OfficialClientFile(Candidate) then
    begin
      if RegQueryStringValue(RootKey, Key, 'InstallLocation', Value) then
        Candidate := AddBackslash(Trim(Value)) + ExpectedWorkBuddyName()
      else
        Candidate := '';
    end;
    ConsiderClientCandidate(Candidate, BestCandidate);
  end;
end;

function ReadSavedClient(var Binary: String; var Version: String;
  var ClientType: String): Boolean;
var
  ResultCode: Integer;
  InfoFile: String;
  Lines: TArrayOfString;
begin
  Result := False;
  InfoFile := ExpandConstant('{tmp}\workbuddy-target-info.txt');
  DeleteFile(InfoFile);
  if not RunNativeHelper('--target-info --output "' + InfoFile + '"', ResultCode) then
    exit;
  if (ResultCode <> 0) or (not LoadStringsFromFile(InfoFile, Lines)) or
    (GetArrayLength(Lines) < 1) then
    exit;
  Binary := Trim(Lines[0]);
  if GetArrayLength(Lines) > 1 then
    Version := Trim(Lines[1])
  else
    Version := '';
  if GetArrayLength(Lines) > 2 then
    ClientType := Trim(Lines[2])
  else
    ClientType := '';
  { Keep a missing saved path visible so an update cannot silently switch an
    enterprise user back to the official client. The page will require them
    to browse to the new location before installation continues. }
  Result := Binary <> '';
end;

function DetectOfficialClient(var Binary: String): Boolean;
var
  Name: String;
  Key: String;
  Value: String;
  Candidate: String;
  Candidates: TArrayOfString;
  Index: Integer;
begin
  Result := False;
  Name := ExpectedWorkBuddyName();
  Candidate := '';

  ConsiderUninstallClients(HKCU,
    'Software\Microsoft\Windows\CurrentVersion\Uninstall', Candidate);
  if IsWin64 then
    ConsiderUninstallClients(HKLM64,
      'Software\Microsoft\Windows\CurrentVersion\Uninstall', Candidate);
  ConsiderUninstallClients(HKLM32,
    'Software\Microsoft\Windows\CurrentVersion\Uninstall', Candidate);

  Key := 'Software\Microsoft\Windows\CurrentVersion\App Paths\' + Name;
  if RegQueryStringValue(HKCU, Key, '', Value) then
    ConsiderClientCandidate(Value, Candidate);
  if IsWin64 and RegQueryStringValue(HKLM64, Key, '', Value) then
    ConsiderClientCandidate(Value, Candidate);
  if RegQueryStringValue(HKLM32, Key, '', Value) then
    ConsiderClientCandidate(Value, Candidate);

  SetArrayLength(Candidates, 5);
  if '{#ProfileId}' = 'workbuddy-ai' then
  begin
    Candidates[0] := ExpandConstant('{localappdata}\Programs\WorkBuddyAI\' + Name);
    Candidates[1] := ExpandConstant('{localappdata}\Programs\WorkBuddy AI\' + Name);
    Candidates[2] := ExpandConstant('{pf}\WorkBuddyAI\' + Name);
    Candidates[3] := ExpandConstant('{pf}\WorkBuddy AI\' + Name);
    Candidates[4] := ExpandConstant('{pf32}\WorkBuddyAI\' + Name);
  end
  else
  begin
    Candidates[0] := ExpandConstant('{localappdata}\Programs\WorkBuddy\' + Name);
    Candidates[1] := ExpandConstant('{localappdata}\WorkBuddy\' + Name);
    Candidates[2] := ExpandConstant('{pf}\WorkBuddy\' + Name);
    Candidates[3] := ExpandConstant('{pf32}\WorkBuddy\' + Name);
    Candidates[4] := ExpandConstant('{userappdata}\WorkBuddy\' + Name);
  end;
  for Index := 0 to GetArrayLength(Candidates) - 1 do
    ConsiderClientCandidate(Candidates[Index], Candidate);

  Binary := Candidate;
  Result := Binary <> '';
  if Result then
    Log('WorkDaddy installer selected official client: ' + Binary)
  else
    Log('WorkDaddy installer did not find an official client for ' + Name);
end;

function PreferDetectedOfficialClient(const SavedPath: String;
  const SavedClientType: String; const DetectedPath: String): Boolean;
begin
  Result := False;
  if (CompareText(SavedClientType, 'official') <> 0) or
    (not OfficialClientFile(DetectedPath)) then
    exit;
  Result := (not UsableClientFile(SavedPath)) or
    (CompareClientFileVersions(DetectedPath, SavedPath) > 0);
end;

procedure UpdateClientDetails();
var
  Candidate: String;
begin
  Candidate := Trim(ClientPage.Values[0]);
  SelectedWorkBuddyVersion := '';
  if UsableClientFile(Candidate) and GetVersionNumbersString(Candidate, SelectedWorkBuddyVersion) then
    ClientVersionLabel.Caption := '检测到版本：' + SelectedWorkBuddyVersion
  else if Candidate = '' then
    ClientVersionLabel.Caption := '尚未选择客户端'
  else if not FileExists(Candidate) then
    ClientVersionLabel.Caption := '未找到这个文件'
  else
    ClientVersionLabel.Caption := '无法读取版本，安装时仍会保存所选路径';
end;

procedure ClientPathChanged(Sender: TObject);
begin
  UpdateClientDetails();
end;

procedure UseDetectedClient(Sender: TObject);
begin
  ClientPage.Values[0] := DetectedOfficialPath;
  ClientSourceLabel.Caption := '已使用自动识别出的官方客户端。';
  UpdateClientDetails();
end;

function ValidateClientSelection(const ShowError: Boolean): Boolean;
begin
  SelectedWorkBuddyPath := Trim(ClientPage.Values[0]);
  Result := UsableClientFile(SelectedWorkBuddyPath);
  if (not Result) and ShowError then
    MsgBox('请选择要连接的 WorkBuddy .exe 主程序。', mbError, MB_OK);
  if Result then
    UpdateClientDetails();
end;

procedure InitializeWizard();
var
  DetectedPath: String;
  DetectedVersion: String;
  SavedClientType: String;
  HasSavedClient: Boolean;
  HasOfficialClient: Boolean;
begin
  ClientPage := CreateInputFilePage(
    wpSelectDir,
    'WorkBuddy 客户端',
    '确认 WorkDaddy 要连接的客户端',
    '安装程序会自动识别客户端。企业专享版或其他安装位置可以点击“浏览”修改。'
  );
  ClientPage.Add('客户端主程序：', '可执行文件 (*.exe)|*.exe|所有文件 (*.*)|*.*', '.exe');

  ClientSourceLabel := TNewStaticText.Create(ClientPage);
  ClientSourceLabel.Parent := ClientPage.Surface;
  ClientSourceLabel.Left := 0;
  ClientSourceLabel.Top := ClientPage.Edits[0].Top + ClientPage.Edits[0].Height + ScaleY(12);
  ClientSourceLabel.Width := ClientPage.SurfaceWidth;
  ClientSourceLabel.Height := ScaleY(18);
  ClientSourceLabel.AutoSize := False;

  ClientVersionLabel := TNewStaticText.Create(ClientPage);
  ClientVersionLabel.Parent := ClientPage.Surface;
  ClientVersionLabel.Left := 0;
  ClientVersionLabel.Top := ClientSourceLabel.Top + ScaleY(24);
  ClientVersionLabel.Width := ClientPage.SurfaceWidth;
  ClientVersionLabel.Height := ScaleY(18);
  ClientVersionLabel.AutoSize := False;

  UseDetectedButton := TNewButton.Create(ClientPage);
  UseDetectedButton.Parent := ClientPage.Surface;
  UseDetectedButton.Left := 0;
  UseDetectedButton.Top := ClientVersionLabel.Top + ScaleY(26);
  UseDetectedButton.Width := ScaleX(126);
  UseDetectedButton.Height := ScaleY(26);
  UseDetectedButton.Caption := '使用自动识别路径';
  UseDetectedButton.OnClick := @UseDetectedClient;
  UseDetectedButton.Visible := False;

  DetectedPath := '';
  DetectedVersion := '';
  SavedClientType := '';
  DetectedOfficialPath := '';
  HasSavedClient := ReadSavedClient(DetectedPath, DetectedVersion, SavedClientType);
  HasOfficialClient := DetectOfficialClient(DetectedOfficialPath);
  if HasSavedClient and
    (CompareText(SavedClientType, 'enterprise') = 0) then
  begin
    ClientSourceLabel.Caption := '已保留上次安装选择，可直接继续或修改。';
    UseDetectedButton.Visible := HasOfficialClient and
      (CompareText(DetectedPath, DetectedOfficialPath) <> 0);
  end
  else if HasOfficialClient and
    ((not HasSavedClient) or PreferDetectedOfficialClient(
      DetectedPath, SavedClientType, DetectedOfficialPath)) then
  begin
    DetectedPath := DetectedOfficialPath;
    if HasSavedClient then
      ClientSourceLabel.Caption := '检测到更新的官方客户端，已自动使用新路径。'
    else
      ClientSourceLabel.Caption := '已自动识别官方客户端，可直接继续或修改。';
  end
  else if HasSavedClient then
  begin
    ClientSourceLabel.Caption := '已保留上次安装选择，可直接继续或修改。';
    UseDetectedButton.Visible := HasOfficialClient and
      (CompareText(DetectedPath, DetectedOfficialPath) <> 0);
  end
  else
    ClientSourceLabel.Caption := '未自动找到客户端，请点击“浏览”选择。';
  ClientPage.Values[0] := DetectedPath;
  ClientPage.Edits[0].OnChange := @ClientPathChanged;
  UpdateClientDetails();
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = ClientPage.ID then
    Result := ValidateClientSelection(True);
end;

function SaveSelectedClient(): Boolean;
var
  NodePath: String;
  ScriptPath: String;
  DataDir: String;
  Parameters: String;
  ResultCode: Integer;
begin
  Result := False;
  NodePath := ExpandConstant('{app}\scripts\runtime\node\node.exe');
  ScriptPath := ExpandConstant('{app}\scripts\workbuddy-target.js');
  DataDir := ExpandConstant('{userappdata}\WorkDaddy');
  if '{#ProfileId}' = 'workbuddy-ai' then
    DataDir := DataDir + '\profiles\workbuddy-ai';
  Parameters := '"' + ScriptPath + '" --configure --profile "{#ProfileId}"' +
    ' --binary "' + SelectedWorkBuddyPath + '" --version "' + SelectedWorkBuddyVersion + '"' +
    ' --data-dir "' + DataDir + '"';
  if not ExecAsOriginalUser(NodePath, Parameters, ExpandConstant('{app}\scripts'), SW_HIDE,
    ewWaitUntilTerminated, ResultCode) then
    exit;
  Result := ResultCode = 0;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    if not SaveSelectedClient() then
      RaiseException('无法保存 WorkBuddy 客户端选择，安装已停止。');
  end;
end;

function ShowWorkBuddyCloseDialog(): Integer;
var
  Dialog: TSetupForm;
  MessageLabel: TNewStaticText;
  DetailLabel: TNewStaticText;
  RetryButton: TNewButton;
  TerminateButton: TNewButton;
  CancelButton: TNewButton;
begin
  Dialog := CreateCustomForm(ScaleX(480), ScaleY(196), False, False);
  try
    Dialog.Caption := '请先退出 WorkBuddy';
    Dialog.ClientWidth := ScaleX(480);
    Dialog.ClientHeight := ScaleY(196);
    Dialog.Position := poScreenCenter;

    MessageLabel := TNewStaticText.Create(Dialog);
    MessageLabel.Parent := Dialog;
    MessageLabel.Left := ScaleX(20);
    MessageLabel.Top := ScaleY(18);
    MessageLabel.Width := ScaleX(440);
    MessageLabel.Height := ScaleY(42);
    MessageLabel.AutoSize := False;
    MessageLabel.WordWrap := True;
    MessageLabel.Font.Style := [fsBold];
    MessageLabel.Caption := '安装前需要完全退出当前的 WorkBuddy。';

    DetailLabel := TNewStaticText.Create(Dialog);
    DetailLabel.Parent := Dialog;
    DetailLabel.Left := ScaleX(20);
    DetailLabel.Top := ScaleY(64);
    DetailLabel.Width := ScaleX(440);
    DetailLabel.Height := ScaleY(50);
    DetailLabel.AutoSize := False;
    DetailLabel.WordWrap := True;
    DetailLabel.Caption := '退出后点击“重新检测”。如果客户端窗口已关闭但后台进程仍未退出，可以点击“结束进程”。只处理当前客户端，不会影响另一个客户端。';

    RetryButton := TNewButton.Create(Dialog);
    RetryButton.Parent := Dialog;
    RetryButton.Width := ScaleX(104);
    RetryButton.Height := ScaleY(28);
    RetryButton.Left := Dialog.ClientWidth - ScaleX(330);
    RetryButton.Top := ScaleY(150);
    RetryButton.Caption := '重新检测';
    RetryButton.Default := True;
    RetryButton.ModalResult := mrOk;

    TerminateButton := TNewButton.Create(Dialog);
    TerminateButton.Parent := Dialog;
    TerminateButton.Width := ScaleX(104);
    TerminateButton.Height := ScaleY(28);
    TerminateButton.Left := Dialog.ClientWidth - ScaleX(216);
    TerminateButton.Top := ScaleY(150);
    TerminateButton.Caption := '结束进程';
    TerminateButton.ModalResult := mrYes;

    CancelButton := TNewButton.Create(Dialog);
    CancelButton.Parent := Dialog;
    CancelButton.Width := ScaleX(104);
    CancelButton.Height := ScaleY(28);
    CancelButton.Left := Dialog.ClientWidth - ScaleX(106);
    CancelButton.Top := ScaleY(150);
    CancelButton.Caption := '取消';
    CancelButton.Cancel := True;
    CancelButton.ModalResult := mrCancel;

    Result := Dialog.ShowModal();
  finally
    Dialog.Free();
  end;
end;

function EnsureWorkBuddyClosed(): Boolean;
var
  ResultCode: Integer;
  Choice: Integer;
begin
  Result := False;
  while True do
  begin
    if not RunNativeHelper('--check-workbuddy --binary "' + SelectedWorkBuddyPath + '"', ResultCode) then
    begin
      MsgBox('无法启动 WorkBuddy 进程检测。请检查安全软件是否拦截安装程序。', mbError, MB_OK);
      exit;
    end;
    if ResultCode = 0 then
    begin
      Result := True;
      exit;
    end;
    if ResultCode <> 10 then
    begin
      MsgBox('无法确认 WorkBuddy 是否已退出（错误码 ' + IntToStr(ResultCode) + '）。安装已停止。', mbError, MB_OK);
      exit;
    end;
    Choice := ShowWorkBuddyCloseDialog();
    if Choice = mrCancel then
      exit;
    if Choice = mrYes then
    begin
      if not RunNativeHelper('--terminate-workbuddy --binary "' + SelectedWorkBuddyPath + '"', ResultCode) then
      begin
        MsgBox('无法启动 WorkBuddy 结束进程操作。请检查安全软件是否拦截安装程序。', mbError, MB_OK);
        exit;
      end;
      if ResultCode <> 0 then
      begin
        MsgBox('无法安全结束当前 WorkBuddy 进程。可能原因：' + #13#10 +
          '• WorkBuddy 由其他用户或管理员权限启动，当前安装器无法跨权限结束；' + #13#10 +
          '• 系统正在退出客户端，进程状态暂时不可查询；' + #13#10 +
          '• 安全软件或系统策略阻止结束进程，或检测到多个安装目录。' + #13#10 +
          '请手动结束当前客户端后点击“重新检测”。', mbError, MB_OK);
      end;
    end;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Result := '';
  if IsAdminInstallMode then
  begin
    Result := '当前安装程序是以管理员权限运行的，无法继续安装。为避免 WorkDaddy 后台出现权限不一致，请点击“取消”，关闭安装程序后直接双击安装包重新运行；不要选择“以管理员身份运行”。UAC 无需关闭。';
    exit;
  end;
  if not ValidateClientSelection(False) then
  begin
    Result := '没有可用的 WorkBuddy 客户端路径。请返回“WorkBuddy 客户端”页面选择 .exe 主程序。';
    exit;
  end;
  if not EnsureWorkBuddyClosed() then
  begin
    Result := '无法确认 WorkBuddy 已退出。可能原因是客户端仍有后台进程、进程权限高于当前用户、系统正在退出客户端，或安全软件阻止了进程检测。请手动结束当前客户端后重新运行安装程序。';
    exit;
  end;

  if not RunNativeHelper(
    '--stop-lifecycle --app-dir "' + ExpandConstant('{app}') + '"',
    ResultCode
  ) then
  begin
    Result := '无法启动 WorkDaddy 后台进程清理。可能原因是安装器原始用户权限不可用、安全软件拦截了临时 helper，或临时目录不可写。请点击“取消”，关闭安装程序后直接双击安装包重新运行；不要选择“以管理员身份运行”。UAC 无需关闭。';
    exit;
  end;
  if ResultCode = 11 then
    Result := '无法安全停止 WorkDaddy 后台进程。可能原因：' + #13#10 +
      '• 正在运行的 WorkDaddy 使用了高于当前安装器的权限，普通安装器不会跨权限强行结束；' + #13#10 +
      '• WorkDaddy 退出后仍有后台进程未及时结束，或文件仍被占用；' + #13#10 +
      '• 安全软件或系统策略阻止后台进程退出。' + #13#10 +
      '请手动结束 WorkDaddy 后重试，并确保 WorkDaddy 通过普通方式启动。'
  else if ResultCode <> 0 then
    Result := '无法安全停止 WorkDaddy 后台进程（错误码 ' + IntToStr(ResultCode) + '）。可能原因是进程仍在退出、文件被占用、安装目录不一致，或安全软件拦截。请手动结束 WorkDaddy 后重试。';
end;
