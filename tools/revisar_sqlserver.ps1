# =========================================================================
# revisar_sqlserver.ps1
# Diagnóstico de SQL Server desde consola, sin abrir Configuration Manager.
#
# Responde a las cuatro preguntas que importan, en orden:
#
#   1. ¿Qué instancias hay, y hay alguna POR DEFECTO?
#   2. ¿Están arrancados los servicios (incluido SQL Server Browser)?
#   3. ¿Tiene TCP/IP habilitado cada instancia?
#   4. ¿En qué puerto escucha cada una?
#
# Se lee todo del registro y de los servicios: NO hace falta ser
# administrador ni tener SSMS instalado.
#
# Uso, desde PowerShell en la carpeta del proyecto:
#
#     powershell -ExecutionPolicy Bypass -File tools\revisar_sqlserver.ps1
# =========================================================================

$ErrorActionPreference = 'SilentlyContinue'

function Titulo($t) {
    Write-Host ""
    Write-Host "=== $t ===" -ForegroundColor Yellow
}

function Bien($t) { Write-Host "  [OK]   $t" -ForegroundColor Green }
function Mal($t)  { Write-Host "  [--]   $t" -ForegroundColor Red }
function Nota($t) { Write-Host "         $t" -ForegroundColor DarkGray }

# ------------------------------------------------------------------ #
# 1 · Instancias instaladas
# ------------------------------------------------------------------ #
Titulo "1. Instancias de SQL Server en este equipo"

$claveInst = 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL'
$inst = Get-ItemProperty -Path $claveInst

if (-not $inst) {
    Mal "No hay ninguna instancia de SQL Server instalada."
    Write-Host ""
    Write-Host "  Instala SQL Server Express y vuelve a ejecutar esto." -ForegroundColor Yellow
    exit 1
}

$nombres = $inst.PSObject.Properties |
    Where-Object { $_.Name -notlike 'PS*' } |
    Select-Object -ExpandProperty Name

foreach ($n in $nombres) { Bien "$n" }

# MSSQLSERVER es el nombre interno de la instancia POR DEFECTO: es la única
# que responde en `localhost` a secas y en el puerto 1433.
$hayDefecto = $nombres -contains 'MSSQLSERVER'
Write-Host ""
if ($hayDefecto) {
    Bien "Hay instancia POR DEFECTO -> en el HMI puedes usar Host = localhost"
} else {
    Mal "NO hay instancia por defecto."
    Nota "Por eso 'localhost:1433' no responde: ese puerto es el de la"
    Nota "instancia por defecto, que en este equipo no existe."
    Nota ""
    Nota "En el HMI, en el campo Host, escribe una de estas:"
    foreach ($n in $nombres) { Nota "    localhost\$n" }
}

# ------------------------------------------------------------------ #
# 2 · Servicios
# ------------------------------------------------------------------ #
Titulo "2. Servicios"

foreach ($n in $nombres) {
    $svc = if ($n -eq 'MSSQLSERVER') { 'MSSQLSERVER' } else { "MSSQL`$$n" }
    $s = Get-Service -Name $svc
    if ($s -and $s.Status -eq 'Running') { Bien "SQL Server ($n): en ejecución" }
    elseif ($s) { Mal "SQL Server ($n): $($s.Status)  ->  Start-Service '$svc'" }
    else { Mal "SQL Server ($n): servicio no encontrado" }
}

# SQL Server Browser es OBLIGATORIO para conectar por nombre de instancia:
# es quien traduce 'HOST\INSTANCIA' al puerto dinámico que esté usando.
$b = Get-Service -Name 'SQLBrowser'
if ($b -and $b.Status -eq 'Running') {
    Bien "SQL Server Browser: en ejecución (necesario para HOST\INSTANCIA)"
} else {
    Mal "SQL Server Browser: $(if ($b) { $b.Status } else { 'no encontrado' })"
    Nota "Sin él no se puede conectar por nombre de instancia. Arráncalo con:"
    Nota "    Set-Service SQLBrowser -StartupType Automatic; Start-Service SQLBrowser"
}

# ------------------------------------------------------------------ #
# 3 y 4 · TCP/IP y puerto de cada instancia
# ------------------------------------------------------------------ #
Titulo "3. TCP/IP y puerto por instancia"

foreach ($n in $nombres) {
    # El identificador interno (MSSQL16.NOMBRE) cambia con la versión, así que
    # se lee del registro en vez de adivinarlo.
    $id = (Get-ItemProperty -Path $claveInst).$n
    $tcp = "HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\$id\MSSQLServer\SuperSocketNetLib\Tcp"

    $hab = (Get-ItemProperty -Path $tcp).Enabled
    $ipall = Get-ItemProperty -Path "$tcp\IPAll"

    Write-Host ""
    Write-Host "  --- $n ---" -ForegroundColor Cyan

    if ($hab -eq 1) { Bien "TCP/IP habilitado" }
    else {
        Mal "TCP/IP DESHABILITADO  <- es lo que impide conectar"
        Nota "Configuration Manager -> Protocolos de $n -> TCP/IP -> Habilitado = Si"
        Nota "y despues reinicia el servicio."
    }

    $din = $ipall.TcpDynamicPorts
    $fijo = $ipall.TcpPort

    if ($fijo) {
        Bien "Puerto ESTATICO: $fijo"
        Nota "En el HMI puedes usar Host = localhost\$n (el puerto se ignora)"
        Nota "o bien Host = localhost + Puerto = $fijo si es la instancia por defecto."
    } elseif ($din) {
        Bien "Puerto DINAMICO actual: $din"
        Nota "Cambia en cada reinicio del servicio. Por eso hay que conectar"
        Nota "como localhost\$n y dejar que SQL Server Browser lo resuelva."
    } else {
        Nota "Sin puerto asignado (normal si TCP/IP esta apagado)."
    }
}

# ------------------------------------------------------------------ #
# 5 · Prueba real de conexión
# ------------------------------------------------------------------ #
Titulo "4. Prueba de conexión (con tu cuenta de Windows)"

foreach ($n in $nombres) {
    $servidor = if ($n -eq 'MSSQLSERVER') { 'localhost' } else { "localhost\$n" }
    try {
        # Se usa .NET directamente: no depende de sqlcmd ni del módulo SqlServer.
        $cn = New-Object System.Data.SqlClient.SqlConnection
        $cn.ConnectionString =
            "Server=$servidor;Integrated Security=true;Connect Timeout=5;TrustServerCertificate=true"
        $cn.Open()
        $cmd = $cn.CreateCommand()
        $cmd.CommandText = "SELECT @@SERVERNAME"
        $r = $cmd.ExecuteScalar()
        $cn.Close()
        Bien "$servidor  ->  CONECTA  (servidor: $r)"
    } catch {
        Mal "$servidor  ->  $($_.Exception.Message.Split([Environment]::NewLine)[0])"
    }
}

# ------------------------------------------------------------------ #
# 5 · Modo de autenticación y logins SQL
# ------------------------------------------------------------------ #
#
# Lo anterior conecta con la cuenta de Windows, que casi siempre funciona
# porque quien instaló SQL Server quedó como administrador. Pero el HMI se
# conecta con un usuario/contraseña de SQL Server, y eso son DOS cosas más:
#
#   1. Que la instancia acepte «autenticación mixta». De fábrica, SQL Server
#      Express se instala en modo «solo Windows», y entonces NINGÚN
#      usuario/contraseña funciona por muy bien escrito que esté.
#   2. Que el login exista.
#
# Sin este bloque, el siguiente error sería «Login failed for user 'psi'»,
# que no distingue entre "no existe", "contraseña mal" y "el modo mixto está
# apagado" — tres problemas con tres soluciones distintas.
Titulo "5. Autenticacion: modo y logins"

# Usuario que se quiere comprobar. Cambia esto si usas otro nombre.
$loginHmi = 'psi'

foreach ($n in $nombres) {
    $servidor = if ($n -eq 'MSSQLSERVER') { 'localhost' } else { "localhost\$n" }
    Write-Host ""
    Write-Host "  --- $n ---" -ForegroundColor Cyan
    try {
        $cn = New-Object System.Data.SqlClient.SqlConnection
        $cn.ConnectionString =
            "Server=$servidor;Integrated Security=true;Connect Timeout=5;TrustServerCertificate=true"
        $cn.Open()

        # 1 = solo Windows, 0 = mixta (Windows + SQL). El nombre de la
        # propiedad es confuso a propósito en SQL Server; el 1 es el
        # restrictivo.
        $cmd = $cn.CreateCommand()
        $cmd.CommandText = "SELECT SERVERPROPERTY('IsIntegratedSecurityOnly')"
        $soloWindows = [int]$cmd.ExecuteScalar()

        if ($soloWindows -eq 1) {
            Mal "Modo: SOLO Windows  <- ningun usuario/contrasena funcionara"
            Nota "El HMI necesita autenticacion MIXTA. Para activarla:"
            Nota "  SSMS -> clic derecho en el servidor -> Propiedades -> Seguridad"
            Nota "  -> 'Modo de autenticacion de SQL Server y de Windows' -> Aceptar"
            Nota "  -> reiniciar el servicio 'SQL Server ($n)'."
            Nota "Alternativa SIN tocar nada: usa la cuenta de Windows (ver abajo)."
        } else {
            Bien "Modo: MIXTO (acepta usuario y contrasena de SQL Server)"
        }

        # ¿Existe el login que va a usar el HMI?
        $cmd.CommandText =
            "SELECT COUNT(*) FROM sys.sql_logins WHERE name = '$loginHmi'"
        $existe = [int]$cmd.ExecuteScalar()

        if ($existe -gt 0) {
            Bien "El login '$loginHmi' EXISTE en esta instancia"
            $cmd.CommandText =
                "SELECT is_disabled FROM sys.sql_logins WHERE name = '$loginHmi'"
            if ([int]$cmd.ExecuteScalar() -eq 1) {
                Mal "...pero esta DESHABILITADO"
                Nota "ALTER LOGIN [$loginHmi] ENABLE;"
            }
        } else {
            Mal "El login '$loginHmi' NO existe en esta instancia"
            Nota "Creala ejecutando esto en SSMS (o pidele a Psi Core que"
            Nota "provisione la base, que lo hace solo):"
            Nota ""
            Nota "  CREATE LOGIN [$loginHmi] WITH PASSWORD = 'TuPasswordFuerte_2026!',"
            Nota "       CHECK_POLICY = OFF;"
            Nota "  -- y dentro de la base que vayas a usar:"
            Nota "  USE [hmi_pruebas];"
            Nota "  CREATE USER [$loginHmi] FOR LOGIN [$loginHmi];"
            Nota "  ALTER ROLE db_owner ADD MEMBER [$loginHmi];"
        }
        $cn.Close()
    } catch {
        Mal "No se pudo comprobar: $($_.Exception.Message.Split([Environment]::NewLine)[0])"
    }
}

Write-Host ""
Write-Host "=== Resumen ===" -ForegroundColor Yellow
Write-Host ""
Write-Host "  En el HMI, campo 'Host', escribe la instancia COMPLETA:" -ForegroundColor White
foreach ($n in $nombres) {
    if ($n -ne 'MSSQLSERVER') { Write-Host "      localhost\$n" -ForegroundColor Cyan }
}
Write-Host "  El campo 'Puerto' se ignora: lo resuelve SQL Server Browser."
Write-Host ""
Write-Host "  Si el login SQL no existe o el modo es 'solo Windows', tienes" -ForegroundColor White
Write-Host "  dos salidas:"
Write-Host "    (a) Crear el login (ver los comandos de arriba), o"
Write-Host "    (b) Entrar con la cuenta de Windows: deja Usuario y Contrasena"
Write-Host "        VACIOS y anade la opcion  Trusted_Connection = yes"
Write-Host ""
