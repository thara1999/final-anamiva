const Consent = require("../models/consent");
const AccessRequest = require("../models/accessrequest");
const Doctor = require("../models/doctor");

/* =========================
   GET CONSENTS (Patient)
========================= */
exports.getConsents = async (req, res) => {
  try {
    const consents = await Consent.find({ patientId: req.user.id, status: "active" })
      .populate({ path: "doctorId", populate: { path: "userId", select: "name fullName" } })
      .populate("appointmentId");

    res.json({ success: true, consents });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/* =========================
   CREATE CONSENT (Patient grants)
========================= */
exports.createConsent = async (req, res) => {
  try {
    const { doctorId, appointmentId, type = "consultation" } = req.body;

    // Check if consent already exists
    const existing = await Consent.findOne({
      patientId: req.user.id,
      doctorId,
      appointmentId: appointmentId || undefined,
      status: "active",
    });

    if (existing) {
      return res.json({ success: true, consent: existing, message: "Consent already exists" });
    }

    const consent = await Consent.create({
      patientId: req.user.id,
      doctorId,
      appointmentId,
      type,
      expiresAt: type === "consultation"
        ? new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours
        : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
    });

    // Notify doctor via socket
    try {
      const { getIO } = require("../sockets/socket");
      const io = getIO();
      const doctorProfile = await Doctor.findById(doctorId);
      if (doctorProfile) {
        io.to(`user_${doctorProfile.userId.toString()}`).emit("consent-granted", {
          consentId: consent._id,
          patientId: req.user.id,
          appointmentId,
          type,
        });
      }
    } catch (socketErr) {
      console.warn("Socket emit failed:", socketErr.message);
    }

    res.status(201).json({ success: true, consent });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/* =========================
   REVOKE CONSENT
========================= */
exports.revokeConsent = async (req, res) => {
  try {
    const consent = await Consent.findById(req.params.consentId);
    if (!consent) return res.status(404).json({ success: false, message: "Consent not found" });
    if (consent.patientId.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    consent.status = "revoked";
    consent.revokedAt = new Date();
    await consent.save();

    res.json({ success: true, consent });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/* =========================
   REVOKE EXTENDED CONSENT
========================= */
exports.revokeExtendedConsent = async (req, res) => {
  try {
    const { patientId, doctorId } = req.body;
    const consent = await Consent.findOne({
      patientId: patientId || req.user.id,
      doctorId,
      type: "extended",
      status: "active",
    });

    if (!consent) return res.status(404).json({ success: false, message: "No active extended consent found" });

    consent.status = "revoked";
    consent.revokedAt = new Date();
    await consent.save();

    res.json({ success: true, consent });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/* =========================
   CHECK ACCESS STATUS
========================= */
exports.checkAccess = async (req, res) => {
  try {
    const { doctorId, patientId, appointmentId } = req.query;
    const pid = patientId || req.user.id;

    const filter = { patientId: pid, status: "active" };
    if (doctorId) filter.doctorId = doctorId;
    if (appointmentId) filter.appointmentId = appointmentId;

    const consent = await Consent.findOne(filter);

    if (consent) {
      // Check if expired
      if (consent.expiresAt && new Date() > consent.expiresAt) {
        consent.status = "expired";
        await consent.save();
        return res.json({ success: true, status: "NO_ACCESS", type: null });
      }
      return res.json({ success: true, status: "GRANTED", type: consent.type, consentId: consent._id });
    }

    // Check if there's a pending request
    const pendingRequest = await AccessRequest.findOne({
      patientId: pid,
      ...(doctorId ? { doctorId } : {}),
      status: "pending",
    });

    if (pendingRequest) {
      return res.json({ success: true, status: "PENDING", type: null, requestId: pendingRequest._id });
    }

    res.json({ success: true, status: "NO_ACCESS", type: null });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/* =========================
   REQUEST ACCESS (Doctor requests)
========================= */
exports.requestAccess = async (req, res) => {
  try {
    const { patientId, appointmentId } = req.body;

    const doctorProfile = await Doctor.findOne({ userId: req.user.id });
    if (!doctorProfile) return res.status(400).json({ success: false, message: "Doctor profile not found" });

    // Check for existing pending request
    const existing = await AccessRequest.findOne({
      doctorId: doctorProfile._id,
      patientId,
      status: "pending",
    });

    if (existing) {
      return res.json({ success: true, request: existing, message: "Request already pending" });
    }

    const request = await AccessRequest.create({
      doctorId: doctorProfile._id,
      doctorUserId: req.user.id,
      patientId,
      appointmentId,
    });

    // Notify patient via socket
    try {
      const { getIO } = require("../sockets/socket");
      const io = getIO();
      io.to(`user_${patientId}`).emit("consultation-access-requested", {
        requestId: request._id,
        doctorId: doctorProfile._id,
        doctorName: req.user.name || "Doctor",
        appointmentId,
      });
    } catch (socketErr) {
      console.warn("Socket emit failed:", socketErr.message);
    }

    res.status(201).json({ success: true, request });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/* =========================
   GET PENDING REQUESTS (Patient)
========================= */
exports.getPendingRequests = async (req, res) => {
  try {
    const requests = await AccessRequest.find({ patientId: req.user.id, status: "pending" })
      .populate({ path: "doctorId", populate: { path: "userId", select: "name fullName" } })
      .populate("appointmentId");

    res.json({ success: true, requests });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/* =========================
   APPROVE REQUEST (Patient)
========================= */
exports.approveRequest = async (req, res) => {
  try {
    const request = await AccessRequest.findById(req.params.requestId);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    if (request.patientId.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    request.status = "approved";
    request.respondedAt = new Date();
    await request.save();

    // Auto-create consent
    await Consent.create({
      patientId: req.user.id,
      doctorId: request.doctorId,
      appointmentId: request.appointmentId,
      type: "consultation",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    // Notify doctor via socket
    try {
      const { getIO } = require("../sockets/socket");
      const io = getIO();
      io.to(`user_${request.doctorUserId.toString()}`).emit("access-request-approved", {
        requestId: request._id,
        patientId: req.user.id,
        appointmentId: request.appointmentId,
      });
    } catch (socketErr) {
      console.warn("Socket emit failed:", socketErr.message);
    }

    res.json({ success: true, request });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/* =========================
   DENY REQUEST (Patient)
========================= */
exports.denyRequest = async (req, res) => {
  try {
    const request = await AccessRequest.findById(req.params.requestId);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    if (request.patientId.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    request.status = "denied";
    request.respondedAt = new Date();
    await request.save();

    res.json({ success: true, request });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
