// Tipos específicos da integração uazapi (WhatsApp)
export interface UazapiSendTextPayload {
  phone: string;
  message: string;
}

export interface UazapiSendImagePayload {
  phone: string;
  image: string; // URL HTTPS ou base64
  caption?: string;
}

export interface UazapiSendAudioPayload {
  phone: string;
  audio: string;
  ptt: boolean; // true = mensagem de voz
}

export interface UazapiSendDocumentPayload {
  phone: string;
  document: string;
  filename: string;
}

export interface UazapiSendPixButtonPayload {
  phone: string;
  body: string;
  pix_code: string;
  button_text: string;
}

export interface UazapiInstanceStatus {
  status: 'connected' | 'disconnected' | 'qr_pending';
  phone?: string;
  name?: string;
}

export interface WhatsAppInstance {
  id: string;
  connectionId: string;
  instanceId: string;
  phone?: string | null;
  profileName?: string | null;
  status: 'pending' | 'qr_pending' | 'connected' | 'disconnected' | 'error';
}
