const multer = require('multer');

// Configuração do Multer para guardar o ficheiro na memória 
// em vez de o colocar no disco, para eficiência
const storage = multer.memoryStorage();

// Configurar o middleware de upload
const upload = multer({ 
  storage: storage,
  limits: { 
    fileSize: 10 * 1024 * 1024  // Limitar a 10 MB para evitar abusos
  },
  fileFilter: (req, file, cb) => {
    // Verificar se o tipo do ficheiro é xlsx ou xls
    if (
      file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || 
      file.mimetype === 'application/vnd.ms-excel' ||
      file.mimetype === 'application/octet-stream' // Alguns browsers podem enviar com este mimetype
    ) {
      // Aceitar o ficheiro
      cb(null, true);
    } else {
      // Rejeitar o ficheiro
      cb(new Error('Tipo de ficheiro inválido. Apenas .xlsx ou .xls são permitidos.'), false);
    }
  }
});

module.exports = upload; 