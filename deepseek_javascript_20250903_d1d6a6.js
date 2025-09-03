const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const PDFDocument = require('pdfkit');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
require('dotenv').config();

const app = express();

// Validate required environment variables
const requiredEnvVars = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'PAYSTACK_SECRET'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`ERROR: Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

// Enhanced CORS configuration
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? (process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [])
    : ['http://localhost:3000'],
  credentials: true
}));

app.use(bodyParser.json());

const PORT = process.env.PORT || 4000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET;
const PAYSTACK_WEBHOOK_SECRET = process.env.PAYSTACK_WEBHOOK_SECRET;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Welcome route
app.get('/', (req, res) => {
  res.send('<h1>Welcome to Alafia Housecalls 🏥</h1><p>Your mobile hospital</p>');
});

// Custom error classes for better error handling
class AppError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

class DatabaseError extends AppError {
  constructor(message) {
    super(message, 500);
  }
}

class PaymentError extends AppError {
  constructor(message) {
    super(message, 400);
  }
}

// Global error handling middleware
app.use((error, req, res, next) => {
  error.statusCode = error.statusCode || 500;
  error.status = error.status || 'error';

  console.error('Error:', error);

  res.status(error.statusCode).json({
    status: error.status,
    message: error.message,
    ...(process.env.NODE_ENV === 'development' && { stack: error.stack })
  });
});

// Utility function to verify Paystack webhook signature
function verifyPaystackSignature(req) {
  if (!PAYSTACK_WEBHOOK_SECRET) {
    console.warn('Paystack webhook secret not configured, skipping signature verification');
    return true;
  }
  
  const hash = crypto
    .createHmac('sha512', PAYSTACK_WEBHOOK_SECRET)
    .update(JSON.stringify(req.body))
    .digest('hex');
  
  return hash === req.headers['x-paystack-signature'];
}

// Create payment record with enhanced error handling
async function createPaymentRecord(appointment_id, amount_ngn, provider, ref) {
  try {
    const { data, error } = await supabase
      .from('payments')
      .insert([{ 
        appointment_id, 
        amount_ngn, 
        provider, 
        status: 'initiated', 
        ref 
      }])
      .select();

    if (error) {
      throw new DatabaseError(`Failed to create payment record: ${error.message}`);
    }

    return data[0];
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new DatabaseError('Unexpected database error occurred');
  }
}

// Update payment status with enhanced error handling
async function updatePaymentStatus(reference, status, appointment_id = null) {
  try {
    const { error: paymentError } = await supabase
      .from('payments')
      .update({ status })
      .eq('ref', reference);

    if (paymentError) {
      throw new DatabaseError(`Failed to update payment status: ${paymentError.message}`);
    }

    // Update appointment status if payment is successful and appointment_id is provided
    if (status === 'paid' && appointment_id) {
      const { error: appointmentError } = await supabase
        .from('appointments')
        .update({ status: 'confirmed' })
        .eq('id', appointment_id);

      if (appointmentError) {
        console.error('Failed to update appointment status:', appointmentError.message);
        // We don't throw here as the payment was successfully recorded
      }
    }

    return true;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new DatabaseError('Unexpected error updating payment status');
  }
}

// Initialize Paystack payment
app.post('/paystack/init', async (req, res, next) => {
  try {
    const { appointment_id, amount_ngn, patient_email } = req.body;
    
    if (!appointment_id || !amount_ngn) {
      throw new PaymentError('appointment_id and amount_ngn are required');
    }

    const ref = 'ps_ref_' + uuidv4();
    await createPaymentRecord(appointment_id, amount_ngn, 'paystack', ref);

    const initResp = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: { 
        Authorization: `Bearer ${PAYSTACK_SECRET}`, 
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify({ 
        amount: amount_ngn * 100, 
        email: patient_email || 'customer@example.com', 
        reference: ref, 
        metadata: { appointment_id } 
      })
    });

    const json = await initResp.json();
    
    if (!json.status) {
      // Update payment status to failed if initialization fails
      await updatePaymentStatus(ref, 'failed');
      throw new PaymentError('Paystack initialization failed: ' + (json.message || 'Unknown error'));
    }

    res.json({ 
      authorization_url: json.data.authorization_url, 
      access_code: json.data.access_code, 
      reference: ref 
    });
  } catch (error) {
    next(error);
  }
});

// Paystack webhook with signature verification
app.post('/paystack/webhook', async (req, res, next) => {
  try {
    // Verify webhook signature for security
    if (!verifyPaystackSignature(req)) {
      console.error('Invalid webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const event = req.body;
    console.log('Paystack webhook received', event.event);

    if (event.event === 'charge.success') {
      const reference = event.data.reference;
      const appointment_id = event.data.metadata?.appointment_id;
      
      await updatePaymentStatus(reference, 'paid', appointment_id);
    } else if (event.event === 'charge.failed') {
      const reference = event.data.reference;
      await updatePaymentStatus(reference, 'failed');
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Generate prescription PDF
app.post('/prescriptions', async (req, res, next) => {
  try {
    const { appointment_id, doctor_name, patient_name, medicines, diagnosis, instructions } = req.body;
    
    if (!appointment_id) {
      throw new AppError('appointment_id is required', 400);
    }

    const doc = new PDFDocument();
    const filename = `prescription-${appointment_id}.pdf`;
    const filepath = path.join(__dirname, 'prescriptions', filename);
    
    // Ensure prescriptions directory exists
    if (!fs.existsSync(path.join(__dirname, 'prescriptions'))) {
      fs.mkdirSync(path.join(__dirname, 'prescriptions'));
    }

    const stream = fs.createWriteStream(filepath);
    doc.pipe(stream);

    // Header
    doc.fontSize(20).text('MEDICAL PRESCRIPTION', { align: 'center' });
    doc.moveDown();
    
    // Doctor and patient info
    doc.fontSize(12)
       .text(`Doctor: ${doctor_name || 'Dr. Unknown'}`, { continued: true })
       .text(`Date: ${new Date().toLocaleDateString()}`, { align: 'right' });
    
    doc.text(`Patient: ${patient_name || 'Unknown Patient'}`);
    doc.moveDown();

    // Diagnosis if provided
    if (diagnosis) {
      doc.text(`Diagnosis: ${diagnosis}`);
      doc.moveDown();
    }

    // Medicines
    doc.text('Prescribed Medications:', { underline: true });
    doc.moveDown(0.5);
    
    (medicines || []).forEach((med, i) => {
      doc.text(`${i + 1}. ${med}`);
    });
    
    doc.moveDown();

    // Additional instructions if provided
    if (instructions) {
      doc.text('Additional Instructions:', { underline: true });
      doc.moveDown(0.5);
      doc.text(instructions);
    }

    // Footer
    doc.moveDown(2);
    doc.text('Signature: _________________________', { align: 'right' });
    doc.text(doctor_name || 'Dr. Unknown', { align: 'right' });

    doc.end();

    stream.on('finish', () => {
      res.json({ 
        pdf_url: `${req.protocol}://${req.get('host')}/prescriptions/${filename}`,
        message: 'Prescription generated successfully'
      });
    });

    stream.on('error', (error) => {
      throw new AppError('Failed to generate PDF: ' + error.message, 500);
    });

  } catch (error) {
    next(error);
  }
});

// Serve prescription files
app.use('/prescriptions', express.static(path.join(__dirname, 'prescriptions')));

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    service: 'Medical Appointment API'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    status: 'error',
    message: `Route ${req.originalUrl} not found`
  });
});

app.listen(PORT, () => {
  console.log(`Backend listening on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Supabase URL: ${SUPABASE_URL}`);
});