!ifndef BUILD_UNINSTALLER
  !include "nsProcess.nsh"
  !include "getProcessInfo.nsh"
  Var pid
!endif

!define LEGACY_APP_EXE "中国银行汇率截图-Bonnie.exe"
!define CURRENT_APP_EXE "BonnieFxCapture.exe"

!macro customInit
  !insertmacro FIND_PROCESS "${LEGACY_APP_EXE}" $R8
  ${if} $R8 != 0
    !insertmacro FIND_PROCESS "${CURRENT_APP_EXE}" $R8
  ${endif}
  ${if} $R8 == 0
    pre_uninstall_prompt:
      MessageBox MB_YESNOCANCEL|MB_ICONEXCLAMATION "检测到旧版 ${PRODUCT_NAME} 仍在运行。$\r$\n$\r$\n是: 自动强制结束进程并继续安装。$\r$\n否: 你手动关闭后，我再重试。$\r$\n取消: 退出安装。" IDYES pre_force_kill IDNO pre_wait_manual
      Quit

    pre_wait_manual:
      MessageBox MB_RETRYCANCEL|MB_ICONINFORMATION "请先手动关闭旧版 ${PRODUCT_NAME}，然后点击“重试”继续安装。" /SD IDCANCEL IDRETRY pre_manual_check
      Quit

    pre_manual_check:
      !insertmacro FIND_PROCESS "${LEGACY_APP_EXE}" $R8
      ${if} $R8 != 0
        !insertmacro FIND_PROCESS "${CURRENT_APP_EXE}" $R8
      ${endif}
      ${if} $R8 == 0
        Goto pre_wait_manual
      ${endif}
      Goto pre_done

    pre_force_kill:
      DetailPrint `Force killing running "${PRODUCT_NAME}" before uninstall...`
      !ifdef INSTALL_MODE_PER_ALL_USERS
        nsExec::Exec `taskkill /f /t /im "${LEGACY_APP_EXE}"`
        nsExec::Exec `taskkill /f /t /im "${CURRENT_APP_EXE}"`
        nsExec::Exec `taskkill /f /im "elevate.exe"`
      !else
        nsExec::Exec `%SYSTEMROOT%\System32\cmd.exe /c taskkill /f /t /im "${LEGACY_APP_EXE}" /fi "USERNAME eq %USERNAME%"`
        nsExec::Exec `%SYSTEMROOT%\System32\cmd.exe /c taskkill /f /t /im "${CURRENT_APP_EXE}" /fi "USERNAME eq %USERNAME%"`
        nsExec::Exec `%SYSTEMROOT%\System32\cmd.exe /c taskkill /f /im "elevate.exe" /fi "USERNAME eq %USERNAME%"`
      !endif
      Sleep 1800
      !insertmacro FIND_PROCESS "${LEGACY_APP_EXE}" $R8
      ${if} $R8 != 0
        !insertmacro FIND_PROCESS "${CURRENT_APP_EXE}" $R8
      ${endif}
      ${if} $R8 == 0
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "旧版 ${PRODUCT_NAME} 仍未能关闭。请在任务管理器中结束该进程后重试。" /SD IDCANCEL IDRETRY pre_uninstall_prompt
        Quit
      ${endif}

    pre_done:
  ${endif}
!macroend

!macro customCheckAppRunning
  !ifndef BUILD_UNINSTALLER
    ${GetProcessInfo} 0 $pid $1 $2 $3 $4
    ${if} $3 != "${APP_EXECUTABLE_FILENAME}"
      !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
      ${if} $R0 == 0
        running_prompt:
          MessageBox MB_YESNOCANCEL|MB_ICONEXCLAMATION "检测到 ${PRODUCT_NAME} 正在运行。$\r$\n$\r$\n是: 自动强制结束进程并继续安装。$\r$\n否: 你手动关闭后，我再重试。$\r$\n取消: 退出安装。" IDYES force_kill IDNO wait_manual
          Goto cancel_install

        wait_manual:
          MessageBox MB_RETRYCANCEL|MB_ICONINFORMATION "请先手动关闭 ${PRODUCT_NAME}，然后点击“重试”继续安装。" /SD IDCANCEL IDRETRY manual_check
          Goto cancel_install

        manual_check:
          !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
          ${if} $R0 == 0
            Goto wait_manual
          ${endif}
          Goto app_stopped

        force_kill:
          DetailPrint `Force killing running "${PRODUCT_NAME}"...`
          !ifdef INSTALL_MODE_PER_ALL_USERS
            nsExec::Exec `taskkill /f /t /im "${APP_EXECUTABLE_FILENAME}" /fi "PID ne $pid"`
          !else
            nsExec::Exec `%SYSTEMROOT%\System32\cmd.exe /c taskkill /f /t /im "${APP_EXECUTABLE_FILENAME}" /fi "PID ne $pid" /fi "USERNAME eq %USERNAME%"`
          !endif
          Sleep 1500
          !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
          ${if} $R0 == 0
            MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "${PRODUCT_NAME} 仍未能关闭。请确认没有以管理员权限运行，并在任务管理器中结束进程后重试。" /SD IDCANCEL IDRETRY running_prompt
            Goto cancel_install
          ${endif}

        app_stopped:
      ${endif}
    ${endif}

    Goto done

    cancel_install:
      Quit

    done:
  !endif
!macroend
