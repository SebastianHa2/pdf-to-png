// server.js (entry point for Cloud Run)

const express = require('express')
const bodyParser = require('body-parser') // or express.json()
const { Storage } = require('@google-cloud/storage')
const fs = require('fs')
const rimraf = require('rimraf')
const os = require('os')
const gs = require('ghostscript')
const admin = require('firebase-admin');

const app = express()
app.use(bodyParser.json()) // parse JSON bodies

// Parse the service account JSON from the injected secret
const serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS);

// Initialize Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// Initialize Google Cloud Storage with the parsed credentials
const storage = new Storage({
  credentials: serviceAccount,
});

// The name of your bucket
const BUCKET_NAME = 'pdf-to-png'
const DESTINATION_BUCKET = 'pdf-to-png-output'

// This is the main endpoint that Pub/Sub (push subscription) will POST to
app.post('/', async (req, res) => {
  try {
    // Pub/Sub messages come in the form:
    // {
    //   "message": {
    //     "data": "base64-encoded JSON string",
    //     "attributes": {...}
    //   },
    //   "subscription": "projects/.../subscriptions/..."
    // }
    const pubsubMessage = req.body?.message
    if (!pubsubMessage || !pubsubMessage.data) {
      console.error('No pubsub message received')
      return res.sendStatus(400)
    }

    // Decode the base64-encoded JSON
    const eventDataString = Buffer.from(pubsubMessage.data, 'base64').toString('utf-8')
    console.log('Decoded Pub/Sub event data:', eventDataString)

    // This JSON should represent a GCS "Object Finalize" event (depending on your setup)
    // Example shape: { "bucket": "pdf-to-png", "name": "somefolder/my.pdf", ... }
    const gcsEvent = JSON.parse(eventDataString)

    // Extract bucket & file info
    const bucketName = gcsEvent.bucket || BUCKET_NAME
    const filePath = gcsEvent.name

    console.log(`Received finalize event for file: ${filePath} in bucket: ${bucketName}`)

    // Only handle .pdf
    if (!filePath.toLowerCase().endsWith('.pdf')) {
      console.log('Skipping non-PDF file:', filePath)
      return res.status(200).send('Not a PDF, ignoring.')
    }

    // Extract orderId and orderItemId from the file name
    const match = filePath.match(/\(([^)]+)\)\(([^)]+)\)/);
    if (!match) {
      console.error(`Invalid file name format: ${filePath}`);
      return res.status(400).send('Invalid file name format.');
    }

    const orderId = match[1];
    const orderItemId = match[2];
    console.log(`Extracted orderId: ${orderId}, orderItemId: ${orderItemId}`);

    // Create a /tmp folder
    const tempDir = createTempDir(filePath)

    // 1) Download the PDF
    const localPdfPath = await downloadPdf(bucketName, filePath, tempDir)
    // 2) Convert to PNG
    const localPngPath = await convertPdfToImage(localPdfPath)
    // 3) Upload PNG back
    const newFilePath = filePath.replace(/\.pdf$/i, '.png')
    await uploadImage(localPngPath, DESTINATION_BUCKET, newFilePath)


    if(orderId && orderItemId) {
      // 4) Update Firebase
      const tablesRef = admin.database().ref(`dashboards/-OG_-eWTqeiFDYRakLlc/models`);
      await tablesRef.child('orderItems').child(orderItemId).update({ pngExtracted: true });
      console.log(`Updated pngExtracted=true for orderItem: ${orderItemId}`);

      // 5) Check if all orderItems for this orderId are complete
      const orderItemsSnapshot = await tablesRef
        .child('orderItems')
        .orderByChild('order')
        .equalTo(orderId)
        .once('value');

      let orderItems = orderItemsSnapshot.val();
      if(orderItemsSnapshot.val()) {
        // Only check order items with approved status
        orderItems = Object.values(orderItems).filter(orderItem => orderItem.orderItemStatus === '-O-MBXnADt_rc_l7Lm8U')
        const allExtracted = orderItems.every(item => item.pngExtracted);
  
        if (allExtracted) {
          console.log(`All order items for orderId ${orderId} have been processed.`);
          // Optionally, trigger further actions here (e.g., notifications)
        } else {
          console.log(`Not all order items for orderId ${orderId} have been processed.`);
        }
      }

    }

    // 6) Cleanup
    deleteDir(tempDir)

    console.log(`Successfully converted ${filePath} -> ${newFilePath}`)
    return res.status(200).send(`Converted PDF to PNG for file: ${filePath}`)
  } catch (err) {
    console.error('Error handling PDF->PNG:', err)
    return res.sendStatus(200)
  }
})

function createTempDir (filePath) {
  const safeName = filePath.replace(/\//g, '_').replace(/\./g, '_')
  const tempDir = `${os.tmpdir()}/${safeName}_${Math.random()}`
  fs.mkdirSync(tempDir)
  console.log(`Created temp dir: ${tempDir}`)
  return tempDir
}

async function downloadPdf (bucketName, filePath, tempDir) {
  const destination = `${tempDir}/${filePath.split('/').pop()}`
  console.log(`Downloading gs://${bucketName}/${filePath} to ${destination}`)
  await storage.bucket(bucketName).file(filePath).download({ destination })
  return destination
}

async function convertPdfToImage(pdfPath) {
  const imagePath = pdfPath.replace(/\.pdf$/i, '.png');

  // Wrap paths in quotes to handle special characters
  const quotedPdfPath = `"${pdfPath}"`;
  const quotedImagePath = `"${imagePath}"`;

  console.log(`Converting PDF to PNG: ${quotedPdfPath} -> ${quotedImagePath}`);

  return new Promise((resolve, reject) => {
    try {
      gs()
        .batch()
        .nopause()
        .device('png256') // Use 256-color PNG for speed
        .resolution(72)   // Reduce resolution to 72 DPI
        .output(quotedImagePath) // Use quoted paths
        .input(quotedPdfPath)    // Use quoted paths
        .exec((err, stdout, stderr) => {
          if (!err) {
            console.log('Ghostscript conversion success');
            console.log('stdout:', stdout);
            console.log('stderr:', stderr);
            resolve(imagePath);
          } else {
            console.error('Ghostscript error:', err);
            reject(err);
          }
        });
    } catch (error) {
      console.error('Ghostscript execution failed:', error);
      reject(error);
    }
  });
}

async function uploadImage (localPngPath, bucketName, filePath) {
  console.log(`Uploading PNG to gs://${bucketName}/${filePath}`)
  await storage.bucket(bucketName).upload(localPngPath, { destination: filePath })
  console.log(`Uploaded PNG to gs://${bucketName}/${filePath}`)
}

function deleteDir (dirPath) {
  rimraf.sync(dirPath)
  console.log(`Deleted temp dir: ${dirPath}`)
}

// Start listening on port 8080
const PORT = process.env.PORT || 8080
app.listen(PORT, () => {
  console.log(`PDF-to-PNG service listening on port ${PORT}`)
})