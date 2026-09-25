#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/root/projetos/leitor-inteligente"
TARGET_DIR="/var/www/preview/leitor-inteligente"

echo "=================================================="
echo "🚀 [DEPLOY] Iniciando esteira canônica de deploy"
echo "📅 Data: $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "📁 Origem: ${PROJECT_DIR}"
echo "📁 Destino: ${TARGET_DIR}"
echo "=================================================="

# a) Navegar até a raiz do projeto
cd "${PROJECT_DIR}"

# b) Build de produção (TypeScript + Vite)
echo -e "\n📦 [1/4] Compilando assets de produção (npm run build)..."
npm run build

if [ ! -d "${PROJECT_DIR}/dist" ] || [ ! -f "${PROJECT_DIR}/dist/index.html" ]; then
    echo "❌ [ERRO] Diretório dist ou index.html não encontrado após o build!" >&2
    exit 1
fi

# c) Sincronização atômica eliminando bundles órfãos
echo -e "\n🔄 [2/4] Sincronizando com ${TARGET_DIR} (rsync --delete)..."
mkdir -p "${TARGET_DIR}"
rsync -av --delete "${PROJECT_DIR}/dist/" "${TARGET_DIR}/"

# d) Ajuste de permissões para o Nginx (www-data:www-data)
echo -e "\n🔒 [3/4] Ajustando permissões para www-data..."
chown -R www-data:www-data "${TARGET_DIR}"
find "${TARGET_DIR}" -type d -exec chmod 755 {} +
find "${TARGET_DIR}" -type f -exec chmod 644 {} +
# Garante compatibilidade de resolução de assets em preview.automacaojs.us
ln -sfn "${TARGET_DIR}/assets" "/var/www/preview/assets"
ln -sfn "${TARGET_DIR}/pdfjs" "/var/www/preview/pdfjs"

# e) Validação de integridade do build no Nginx
echo -e "\n🔍 [4/4] Validando integridade dos bundles gerados..."
MAIN_JS=$(grep -o 'assets/index-[^"]*\.js' "${TARGET_DIR}/index.html" | head -n 1)
MAIN_CSS=$(grep -o 'assets/index-[^"]*\.css' "${TARGET_DIR}/index.html" | head -n 1)

if [ -z "${MAIN_JS}" ] || [ ! -f "${TARGET_DIR}/${MAIN_JS}" ]; then
    echo "❌ [ERRO] Bundle principal JS (${MAIN_JS:-não encontrado}) não existe em ${TARGET_DIR}!" >&2
    exit 1
fi

if [ -z "${MAIN_CSS}" ] || [ ! -f "${TARGET_DIR}/${MAIN_CSS}" ]; then
    echo "❌ [ERRO] Bundle principal CSS (${MAIN_CSS:-não encontrado}) não existe em ${TARGET_DIR}!" >&2
    exit 1
fi

TOTAL_ASSETS=$(ls -1 "${TARGET_DIR}/assets" | wc -l)
DIST_ASSETS=$(ls -1 "${PROJECT_DIR}/dist/assets" | wc -l)

if [ "${TOTAL_ASSETS}" -ne "${DIST_ASSETS}" ]; then
    echo "❌ [ERRO] Divergência na contagem de assets: ${TOTAL_ASSETS} em prod vs ${DIST_ASSETS} em dist!" >&2
    exit 1
fi

echo -e "\n=================================================="
echo "✅ [DEPLOY SUCESSO] Build publicado com sucesso!"
echo "📄 Script JS principal: ${MAIN_JS}"
echo "🎨 Estilo CSS principal: ${MAIN_CSS}"
echo "📦 Total de assets em produção: ${TOTAL_ASSETS} (zero bundles órfãos)"
echo "⏱️ Concluído em: $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "=================================================="
