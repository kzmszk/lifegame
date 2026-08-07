@ECHO OFF

SET DIRNAME=%~dp0
IF "%DIRNAME%"=="" SET DIRNAME=.
SET APP_HOME=%DIRNAME%
SET APP_BASE_NAME=%~n0

SET DEFAULT_JVM_OPTS="-Xmx64m" "-Xms64m"

IF DEFINED JAVA_HOME GOTO findJavaFromJavaHome

SET JAVA_EXE=java.exe
%JAVA_EXE% -version >NUL 2>&1
IF %ERRORLEVEL% EQU 0 GOTO execute

ECHO ERROR: JAVA_HOME is not set and no 'java' command could be found in your PATH. 1>&2
GOTO fail

:findJavaFromJavaHome
SET JAVA_EXE=%JAVA_HOME%\bin\java.exe
IF EXIST "%JAVA_EXE%" GOTO execute

ECHO ERROR: JAVA_HOME is set to an invalid directory: %JAVA_HOME% 1>&2
GOTO fail

:execute
SET CLASSPATH=%APP_HOME%\gradle\wrapper\gradle-wrapper.jar
"%JAVA_EXE%" %DEFAULT_JVM_OPTS% %JAVA_OPTS% %GRADLE_OPTS% "-Dorg.gradle.appname=%APP_BASE_NAME%" -classpath "%CLASSPATH%" org.gradle.wrapper.GradleWrapperMain %*
IF %ERRORLEVEL% EQU 0 GOTO end

:fail
EXIT /B 1

:end
@ECHO ON
