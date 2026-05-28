const express = require("express");
const router = express.Router();
const protect = require("../middlewares/authmiddleware");
const {
  getConsents,
  createConsent,
  revokeConsent,
  revokeExtendedConsent,
  checkAccess,
  requestAccess,
  getPendingRequests,
  approveRequest,
  denyRequest,
} = require("../controllers/consentcontroller");

// Consent routes (patient)
router.get("/consents", protect, getConsents);
router.post("/consents", protect, createConsent);
router.delete("/consents/extended", protect, revokeExtendedConsent);
router.delete("/consents/:consentId", protect, revokeConsent);
router.get("/consents/access", protect, checkAccess);

// Access request routes
router.post("/access-requests", protect, requestAccess);
router.get("/access-requests/pending", protect, getPendingRequests);
router.put("/access-requests/:requestId/approve", protect, approveRequest);
router.put("/access-requests/:requestId/deny", protect, denyRequest);

module.exports = router;
