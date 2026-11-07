!ifndef SOUNDCLOUD_ELECTRON_KEY
  !define SOUNDCLOUD_ELECTRON_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\f4439d5a-3c0a-53a5-90c7-aec1a91628f0"
!endif
!ifndef SOUNDCLOUD_PREVIEW_KEY
  !define SOUNDCLOUD_PREVIEW_KEY "Software\rvelabs\SoundCloud Native Preview"
!endif
!ifndef SOUNDCLOUD_PREVIEW_DIRECTORY
  !define SOUNDCLOUD_PREVIEW_DIRECTORY "$LOCALAPPDATA\SoundCloud Native Preview"
!endif
Var SoundCloudLegacyDirectory
Var SoundCloudPreviewDirectory
Var SoundCloudInstallLog
Var SoundCloudUninstallAttempts

Function SoundCloudChooseDirectory
  ${If} $INSTDIR == "$LOCALAPPDATA\SoundCloud"
    ReadRegStr $SoundCloudLegacyDirectory HKCU "${SOUNDCLOUD_ELECTRON_KEY}" "InstallLocation"
    ${If} ${FileExists} "$SoundCloudLegacyDirectory\SoundCloud.exe"
    ${AndIf} ${FileExists} "$SoundCloudLegacyDirectory\resources\app.asar"
      GetFullPathName $INSTDIR "$SoundCloudLegacyDirectory"
    ${Else}
      StrCpy $INSTDIR "$LOCALAPPDATA\Programs\soundcloud-rpc"
    ${EndIf}
  ${EndIf}
FunctionEnd

!define MUI_CUSTOMFUNCTION_GUIINIT SoundCloudChooseDirectory

!macro NSIS_HOOK_PREINSTALL
  Call SoundCloudChooseDirectory
  !insertmacro CheckIfAppIsRunning "$INSTDIR\SoundCloud.exe" "SoundCloud"
  ReadRegStr $SoundCloudPreviewDirectory HKCU "${SOUNDCLOUD_PREVIEW_KEY}" ""
  ${If} $SoundCloudPreviewDirectory == ""
    StrCpy $SoundCloudPreviewDirectory "${SOUNDCLOUD_PREVIEW_DIRECTORY}"
  ${EndIf}
  ${If} ${FileExists} "$SoundCloudPreviewDirectory\soundcloud-native.exe"
    !insertmacro CheckIfAppIsRunning "$SoundCloudPreviewDirectory\soundcloud-native.exe" "SoundCloud"
  ${EndIf}
  InitPluginsDir
  CreateDirectory "$LOCALAPPDATA\soundcloud-rpc-installer"
  FileOpen $SoundCloudInstallLog "$LOCALAPPDATA\soundcloud-rpc-installer\install.log" a
  FileWrite $SoundCloudInstallLog "SoundCloud ${VERSION}: preparing saved data$\r$\n"
  FileClose $SoundCloudInstallLog
  SetOutPath "$PLUGINSDIR"
  File /oname=SoundCloud-migrate.exe "${MAINBINARYSRCPATH}"
  StrCpy $0 -1
  ClearErrors
  ExecWait '"$PLUGINSDIR\SoundCloud-migrate.exe" --prepare-electron-migration' $0
  FileOpen $SoundCloudInstallLog "$LOCALAPPDATA\soundcloud-rpc-installer\install.log" a
  FileWrite $SoundCloudInstallLog "migration exit=$0$\r$\n"
  FileClose $SoundCloudInstallLog
  ${If} $0 != 0
    Abort "SoundCloud could not preserve your previous data. The previous application was not removed."
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\resources\app.asar"
  ${AndIf} ${FileExists} "$INSTDIR\Uninstall SoundCloud.exe"
    GetFullPathName $SoundCloudLegacyDirectory "$INSTDIR"
    ${GetRoot} "$SoundCloudLegacyDirectory" $1
    ${If} $SoundCloudLegacyDirectory == "$LOCALAPPDATA"
    ${OrIf} $SoundCloudLegacyDirectory == "$PROGRAMFILES"
    ${OrIf} $SoundCloudLegacyDirectory == "$WINDIR"
    ${OrIf} $SoundCloudLegacyDirectory == "$DESKTOP"
    ${OrIf} $SoundCloudLegacyDirectory == "$1\"
      Abort "Invalid previous SoundCloud installation directory."
    ${EndIf}
    ClearErrors
    CopyFiles /SILENT "$INSTDIR\Uninstall SoundCloud.exe" "$PLUGINSDIR\SoundCloud-electron-uninstall.exe"
    ${If} ${Errors}
      Abort "Could not prepare the previous SoundCloud uninstaller. Your profile has been preserved."
    ${EndIf}
    StrCpy $SoundCloudUninstallAttempts 0
    ${Do}
      IntOp $SoundCloudUninstallAttempts $SoundCloudUninstallAttempts + 1
      StrCpy $0 -1
      ClearErrors
      ExecWait '"$PLUGINSDIR\SoundCloud-electron-uninstall.exe" /S /KEEP_APP_DATA /currentuser --updated --keep-shortcuts _?=$INSTDIR' $0
      FileOpen $SoundCloudInstallLog "$LOCALAPPDATA\soundcloud-rpc-installer\install.log" a
      FileWrite $SoundCloudInstallLog "electron uninstall attempt=$SoundCloudUninstallAttempts exit=$0$\r$\n"
      FileClose $SoundCloudInstallLog
      ${If} $0 == 0
        ${ExitDo}
      ${EndIf}
      Sleep 500
    ${LoopUntil} $SoundCloudUninstallAttempts >= 3
    ${If} $0 != 0
      Abort "The previous SoundCloud could not be replaced (code $0). Your profile has been preserved. Log: $LOCALAPPDATA\soundcloud-rpc-installer\install.log"
    ${EndIf}
    ${If} ${FileExists} "$INSTDIR\SoundCloud.exe"
    ${OrIf} ${FileExists} "$INSTDIR\resources\app.asar"
      Abort "The previous SoundCloud files are still in use. Your profile has been preserved."
    ${EndIf}
  ${EndIf}
  ${If} ${FileExists} "$SoundCloudPreviewDirectory\uninstall.exe"
  ${AndIf} ${FileExists} "$SoundCloudPreviewDirectory\soundcloud-native.exe"
  ${AndIf} $SoundCloudPreviewDirectory != $INSTDIR
    ClearErrors
    CopyFiles /SILENT "$SoundCloudPreviewDirectory\uninstall.exe" "$PLUGINSDIR\SoundCloud-preview-uninstall.exe"
    ${If} ${Errors}
      Abort "Could not prepare the previous SoundCloud uninstaller. Your profile has been preserved."
    ${EndIf}
    StrCpy $0 -1
    ClearErrors
    ExecWait '"$PLUGINSDIR\SoundCloud-preview-uninstall.exe" /S /UPDATE _?=$SoundCloudPreviewDirectory' $0
    FileOpen $SoundCloudInstallLog "$LOCALAPPDATA\soundcloud-rpc-installer\install.log" a
    FileWrite $SoundCloudInstallLog "previous host uninstall exit=$0$\r$\n"
    FileClose $SoundCloudInstallLog
    ${If} $0 != 0
      Abort "The previous SoundCloud installation is still in use. Your profile has been preserved."
    ${EndIf}
  ${EndIf}
  SetOutPath "$INSTDIR"
!macroend
