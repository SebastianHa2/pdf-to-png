const { Storage } = require('@google-cloud/storage')
const fs = require('fs')
const rimraf = require('rimraf')
const os = require('os')
const gs = require('ghostscript')

const BUCKET_NAME = 'pdf-to-png'

// If you want to auto-detect project from the environment:
const GOOGLE_PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT

// Initialize the Cloud Storage client
const storage = new Storage({ projectId: GOOGLE_PROJECT_ID })

exports.createImage = async (object, context) => {
  // 'object' has properties like bucket, name, contentType, etc.
  const bucketName = object.bucket
  const filePath = object.name

  console.log(`Received event for file: ${filePath} in bucket: ${bucketName}`)

  // Only process .pdf files
  if (!filePath.toLowerCase().endsWith('.pdf')) {
    console.log('Skipping non-PDF file:', filePath)
    return
  }

  // Create a temporary dir in /tmp
  const tempDir = createTempDir(filePath)

  // Download the PDF from GCS to /tmp
  const tmpPdfPath = await downloadPdf(bucketName, tempDir, filePath)

  // Convert PDF -> PNG in /tmp
  const tmpPngPath = await convertPdfToImage(tmpPdfPath)

  // Re-upload the PNG to GCS (same bucket, maybe same path but .png)
  // e.g., "folder/file.pdf" => "folder/file.png"
  const newFilePath = filePath.replace(/\.pdf$/i, '.png')
  await uploadImage(tmpPngPath, bucketName, newFilePath)

  // Cleanup
  deleteDir(tempDir)

  console.log(
    `Conversion complete. PNG uploaded to: gs://${bucketName}/${newFilePath}`
  )
}

// Create a temp directory with the fileName in the path
function createTempDir(fileName) {
  const safeName = fileName.replace(/\//g, '_').replace(/\./g, '_')
  const tempDir = `${os.tmpdir()}/${safeName}_${Math.random()}`
  fs.mkdirSync(tempDir)
  console.log(`Created dir: ${tempDir}`)
  return tempDir
}

// Download PDF from GCS to /tmp
async function downloadPdf(bucketName, tempDir, filePath) {
  const destination = `${tempDir}/${filePath.split('/').pop()}`
  await storage.bucket(bucketName).file(filePath).download({ destination })
  console.log(`Downloaded gs://${bucketName}/${filePath} to ${destination}`)
  return destination
}

// Ghostscript conversion from .pdf -> .png
async function convertPdfToImage(pdfPath) {
  const imagePath = pdfPath.replace(/\.pdf$/i, '.png')

  return new Promise((resolve, reject) => {
    try {
      gs()
        .batch()
        .nopause()
        .device('png16m')
        .output(imagePath)
        .input(pdfPath)
        .exec((err, stdout, stderr) => {
          if (!err) {
            console.log('Ghostscript conversion success')
            console.log('stdout:', stdout)
            console.log('stderr:', stderr)
            resolve(imagePath)
          } else {
            console.error('Ghostscript error:', err)
            reject(err)
          }
        })
    } catch (error) {
      console.error('Ghostscript execution failed:', error)
      reject(error)
    }
  })
}

// Upload PNG back to GCS
async function uploadImage(localPngPath, bucketName, filePath) {
  console.log(
    `Uploading PNG from ${localPngPath} to gs://${bucketName}/${filePath}`
  )

  await storage
    .bucket(bucketName)
    .upload(localPngPath, { destination: filePath })

  console.log(`Successfully uploaded: gs://${bucketName}/${filePath}`)
}

// Cleanup /tmp folder
function deleteDir(dirPath) {
  rimraf.sync(dirPath)
  console.log(`Deleted tmp dir: ${dirPath}`)
}
