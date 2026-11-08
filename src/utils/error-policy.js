function statusOf(error) {
  return Number(error?.status || error?.statusCode || error?.response?.status ||
    error?.cause?.response?.status || 0) || null;
}

function isTimeout(error) {
  const code = String(error?.code || error?.cause?.code || '').toUpperCase();
  const message = String(error?.message || '').toLowerCase();
  return ['ETIMEDOUT','ECONNABORTED','ESOCKETTIMEDOUT'].includes(code) ||
    /timed out|timeout|deadline exceeded/.test(message);
}

function isNetworkError(error) {
  const code = String(error?.code || error?.cause?.code || '').toUpperCase();
  return [
    'ECONNRESET','ECONNREFUSED','EHOSTUNREACH','ENETUNREACH',
    'EAI_AGAIN','ENOTFOUND','EPIPE'
  ].includes(code);
}

function classifyOperationalError(error) {
  const status = statusOf(error);
  if (error?.deliveryStatus === 'uncertain' || error?.uncertain === true) {
    return {
      category: 'delivery_uncertain',
      retryable: false,
      userMessage: 'Bubu belum dapat memastikan apakah pesan atau file sudah terkirim. Periksa chat WhatsApp terlebih dahulu. Bubu tidak akan mengirim ulang otomatis untuk mencegah duplikasi.'
    };
  }
  if (status === 401 || status === 403) {
    return {
      category: 'authentication',
      retryable: false,
      userMessage: 'Bubu sedang mengalami masalah autentikasi dengan salah satu layanan. Admin perlu memeriksa konfigurasi koneksi atau API key.'
    };
  }
  if (status === 429) {
    return {
      category: 'rate_limit',
      retryable: true,
      userMessage: 'Layanan AI sedang sibuk. Bubu belum dapat menyelesaikan permintaan ini. Silakan coba kembali beberapa saat lagi.'
    };
  }
  if (status && status >= 400 && status < 500) {
    return {
      category: 'invalid_request',
      retryable: false,
      userMessage: 'Permintaan belum dapat diproses karena format atau parameter tidak diterima oleh layanan. Coba sederhanakan instruksi atau hubungi admin.'
    };
  }
  if (isTimeout(error)) {
    return {
      category: 'timeout',
      retryable: true,
      userMessage: 'Bubu membutuhkan waktu terlalu lama untuk memproses permintaan. Silakan coba lagi dengan instruksi lebih singkat.'
    };
  }
  if (isNetworkError(error) || (status && status >= 500)) {
    return {
      category: 'upstream_unavailable',
      retryable: true,
      userMessage: 'Salah satu layanan yang digunakan Bubu sedang tidak tersedia. Bubu akan mencoba kembali secara terbatas.'
    };
  }
  if (error?.name === 'ZodError' || /invalid_type|validation|invalid json|tool arguments/i.test(error?.message || '')) {
    return {
      category: 'validation',
      retryable: false,
      userMessage: 'Bubu menerima data yang tidak sesuai saat menjalankan fitur. Silakan ulangi permintaan dengan informasi yang lebih jelas.'
    };
  }
  return {
    category: 'internal',
    retryable: true,
    userMessage: 'Maaf, Bubu mengalami kendala internal saat memproses permintaan. Silakan coba kembali beberapa saat lagi.'
  };
}

module.exports = { classifyOperationalError, statusOf, isTimeout, isNetworkError };
