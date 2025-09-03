const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const PDFDocument = require('pdfkit');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const app = express();
app.use(cors());
app.use(bodyParser.json());
const PORT = process.env.PORT || 4000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
async function createPaymentRecord(appointment_id, amount_ngn, provider, ref) {
  try {
    const { data, error } = await supabase.from('payments').insert([{ appointment_id, amount_ngn, provider, status: 'initiated', ref }]);
    if(error) console.error('Supabase insert error', error);
    return data?.[0];
  } catch (err) { console.error(err); }
}
app.post('/paystack/init', async (req, res) => {
  const { appointment_id, amount_ngn, patient_email } = req.body;
  if(!appointment_id || !amount_ngn) return res.status(400).json({ error: 'appointment_id and amount_ngn required' });
  try {
    const ref = 'ps_ref_' + uuidv4();
    await createPaymentRecord(appointment_id, amount_ngn, 'paystack', ref);
    const initResp = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: amount_ngn * 100, email: patient_email || 'customer@example.com', reference: ref, metadata: { appointment_id } })
    });
    const json = await initResp.json();
    if(!json.status) return res.status(500).json({ error: 'Paystack init failed', details: json });
    return res.json({ authorization_url: json.data.authorization_url, access_code: json.data.access_code, reference: ref });
  } catch (err) { console.error(err); res.status(500).json({ error: 'server error' }); }
});
app.post('/paystack/webhook', async (req, res) => {
  const event = req.body;
  console.log('Paystack webhook received', event);
  if(event?.event === 'charge.success' || event?.data?.status === 'success') {
    const reference = event?.data?.reference;
    try {
      const { data, error } = await supabase.from('payments').update({ status: 'paid' }).eq('ref', reference);
      if(error) console.error('Error updating payment', error);
      const appointment_id = event?.data?.metadata?.appointment_id;
      if(appointment_id) {
        await supabase.from('appointments').update({ status: 'confirmed' }).eq('id', appointment_id);
      }
    } catch (err) { console.error(err); }
  }
  res.sendStatus(200);
});
app.post('/prescriptions', (req, res) => {
  const { appointment_id, doctor_name, patient_name, medicines } = req.body;
  const doc = new PDFDocument();
  const filename = `prescription-${appointment_id || uuidv4()}.pdf`;
  const filepath = path.join(__dirname, filename);
  const stream = fs.createWriteStream(filepath);
  doc.pipe(stream);
  doc.fontSize(20).text('Prescription', { align: 'center' });
  doc.moveDown();
  doc.fontSize(12).text(`Doctor: ${doctor_name || 'Dr.'}`);
  doc.text(`Patient: ${patient_name || 'Patient'}`);
  doc.moveDown();
  doc.text('Medicines:');
  (medicines || ['Paracetamol 500mg']).forEach((m, i) => doc.text(`${i+1}. ${m}`));
  doc.end();
  stream.on('finish', () => { res.json({ pdf_url: `http://localhost:${PORT}/${filename}` }); });
});
app.listen(PORT, () => console.log('Backend listening on', PORT));
