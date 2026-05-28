const mongoose = require("mongoose");

const consentSchema = new mongoose.Schema(
  {
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    doctorId: { type: mongoose.Schema.Types.ObjectId, ref: "Doctor", required: true },
    appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Appointment" },
    type: { type: String, enum: ["consultation", "extended"], default: "consultation" },
    status: { type: String, enum: ["active", "revoked", "expired"], default: "active" },
    grantedAt: { type: Date, default: Date.now },
    revokedAt: Date,
    expiresAt: Date,
  },
  { timestamps: true }
);

module.exports = mongoose.model("Consent", consentSchema);
