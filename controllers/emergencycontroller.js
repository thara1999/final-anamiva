const EmergencyRequest = require('../models/emergencyrequest');
const ChatMessage = require('../models/chatmessage');
const Doctor = require('../models/doctor');
const User = require('../models/user');

/* =========================
   CREATE EMERGENCY REQUEST
   - Patient only
   - Only ONE active emergency per patient
========================= */
exports.createEmergency = async (req, res) => {
  try {
    const { description, symptoms, urgency, location } = req.body;

    // Accept symptoms as fallback for description (frontend sends both)
    const desc = description || symptoms;

    if (!desc || !location) {
      return res.status(400).json({
        success: false,
        message: 'Description/symptoms and location are required',
      });
    }

    // Enforce one active emergency per patient
    const activeEmergency = await EmergencyRequest.findOne({
      patientId: req.user.id,
      status: { $in: ['pending', 'accepted', 'in_progress'] },
    });

    if (activeEmergency) {
      return res.status(409).json({
        success: false,
        message: 'You already have an active emergency request',
      });
    }

    // Build GeoJSON location
    const coordinates = [
      location.longitude || location.lng,
      location.latitude || location.lat,
    ];

    const emergency = await EmergencyRequest.create({
      patientId: req.user.id,
      description: desc,
      urgency: urgency || 'medium',
      location: {
        type: 'Point',
        coordinates,
        address: location.address || '',
      },
    });

    try {
      const { getIO } = require('../sockets/socket');
      const io = getIO();
      io.to('doctors').emit('emergency-created', {
        emergencyId: emergency._id.toString(),
        status: emergency.status,
        urgency: emergency.urgency,
        createdAt: emergency.createdAt,
      });
    } catch (socketErr) {
      console.warn('Socket emit failed:', socketErr.message);
    }

    res.status(201).json({ success: true, emergency });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/* =========================
   GET ACTIVE EMERGENCY (Patient or Doctor)
   - Returns the user's current active emergency
========================= */
exports.getActiveEmergency = async (req, res) => {
  try {
    let filter = {
      status: { $in: ['pending', 'accepted', 'in_progress'] },
    };

    if (req.user.role === 'doctor') {
      const doctorProfile = await Doctor.findOne({ userId: req.user.id });
      if (!doctorProfile) {
        return res.json({ success: true, emergency: null });
      }
      filter.doctorId = doctorProfile._id;
    } else {
      filter.patientId = req.user.id;
    }

    const emergency = await EmergencyRequest.findOne(filter)
      .populate('doctorId')
      .populate('patientId', 'name fullName firstName lastName phoneNumber avatar profilePicture address')
      .sort({ createdAt: -1 });

    if (!emergency) {
      return res.json({ success: true, emergency: null });
    }

    // If doctor has accepted, enrich with doctor user info
    let doctorInfo = null;
    if (emergency.doctorId) {
      const doctorProfile = typeof emergency.doctorId === 'object' ? emergency.doctorId : await Doctor.findById(emergency.doctorId);
      if (doctorProfile) {
        const doctorUser = await User.findById(doctorProfile.userId).select('name fullName firstName lastName phoneNumber profilePicture address');
        doctorInfo = {
          doctorProfileId: doctorProfile._id,
          userId: doctorProfile.userId,
          name: doctorUser?.fullName || doctorUser?.name || 'Doctor',
          phone: doctorUser?.phoneNumber || '',
          avatar: doctorUser?.profilePicture || '',
          specialization: doctorProfile.speciality || '',
          experience: doctorProfile.experience || 0,
          city: doctorUser?.address?.city || '',
        };
      }
    }

    res.json({ success: true, emergency, doctor: doctorInfo });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/* =========================
   GET NEARBY EMERGENCIES
   - Doctor only
   - Location-based search (5km default, expandable to 10km)
========================= */
exports.getNearbyEmergencies = async (req, res) => {
  try {
    const { latitude, longitude, radius = 5 } = req.query;

    if (!latitude || !longitude) {
      return res.status(400).json({
        success: false,
        message: 'Latitude and longitude are required',
      });
    }

    const radiusKm = Math.min(Number(radius), 50); // Cap at 50km

    const emergencies = await EmergencyRequest.find({
      status: 'pending',
      location: {
        $nearSphere: {
          $geometry: {
            type: 'Point',
            coordinates: [Number(longitude), Number(latitude)],
          },
          $maxDistance: radiusKm * 1000, // Convert km to meters
        },
      },
    })
      .populate('patientId', 'name fullName firstName lastName phoneNumber avatar profilePicture address location')
      .sort({ createdAt: -1 });

    res.json({ success: true, emergencies });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/* =========================
   DOCTOR ACCEPTS EMERGENCY
   - Doctor only
   - First-come, first-served (atomic update)
========================= */
exports.acceptEmergency = async (req, res) => {
  try {
    const { estimatedArrival } = req.body;

    // Find doctor profile
    const doctorProfile = await Doctor.findOne({ userId: req.user.id });
    if (!doctorProfile) {
      return res.status(403).json({
        success: false,
        message: 'Doctor profile not found',
      });
    }

    // Atomic update: only accept if still pending (first-come, first-served)
    const emergency = await EmergencyRequest.findOneAndUpdate(
      {
        _id: req.params.requestId,
        status: 'pending',
      },
      {
        status: 'accepted',
        doctorId: doctorProfile._id,
        acceptedAt: new Date(),
        estimatedArrival: estimatedArrival || null,
      },
      { new: true }
    ).populate('patientId', 'name fullName firstName lastName phoneNumber avatar profilePicture address');

    if (!emergency) {
      return res.status(409).json({
        success: false,
        message: 'Emergency already accepted by another doctor or not found',
      });
    }

    // Get doctor user info for the response
    const doctorUser = await User.findById(req.user.id).select('name fullName firstName lastName phoneNumber profilePicture address');

    // Build rich doctor info for the patient
    const doctorInfo = {
      doctorProfileId: doctorProfile._id,
      userId: req.user.id,
      name: doctorUser?.fullName || doctorUser?.name || `Dr. ${doctorUser?.firstName || ''} ${doctorUser?.lastName || ''}`.trim() || 'Doctor',
      phone: doctorUser?.phoneNumber || '',
      avatar: doctorUser?.profilePicture || doctorUser?.avatar || '',
      specialization: doctorProfile.speciality || '',
      experience: doctorProfile.experience || 0,
      city: doctorUser?.address?.city || '',
    };

    // Build patient info for the doctor
    const patientData = emergency.patientId;
    const patientInfo = {
      userId: patientData?._id || patientData,
      name: patientData?.fullName || patientData?.name || `${patientData?.firstName || ''} ${patientData?.lastName || ''}`.trim() || 'Patient',
      phone: patientData?.phoneNumber || '',
      avatar: patientData?.profilePicture || patientData?.avatar || '',
      city: patientData?.address?.city || '',
    };

    // Emit socket event to patient so they get real-time notification
    const patientUserId = typeof patientData === 'object' ? patientData._id?.toString() : patientData?.toString();
    try {
      const { getIO } = require('../sockets/socket');
      const io = getIO();
      if (patientUserId) {
        io.to(`user_${patientUserId}`).emit('emergency-accepted', {
          emergencyId: emergency._id.toString(),
          status: 'accepted',
          doctor: doctorInfo,
          acceptedAt: emergency.acceptedAt,
          estimatedArrival: emergency.estimatedArrival,
        });
      }
    } catch (socketErr) {
      console.warn('Socket emit failed:', socketErr.message);
    }

    res.json({ success: true, emergency, doctor: doctorInfo, patient: patientInfo });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/* =========================
   UPDATE EMERGENCY STATUS
   - Validate status transitions
========================= */
exports.updateEmergencyStatus = async (req, res) => {
  try {
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({
        success: false,
        message: 'Status is required',
      });
    }

    const emergency = await EmergencyRequest.findById(req.params.requestId);
    if (!emergency) {
      return res.status(404).json({
        success: false,
        message: 'Emergency request not found',
      });
    }

    // Authorization: only the patient or assigned doctor can update
    const isPatient = emergency.patientId?.toString() === req.user.id;
    const Doctor = require("../models/doctor");
    const doctorProfile = req.user.role === 'doctor' ? await Doctor.findOne({ userId: req.user.id }) : null;
    const isDoctor = doctorProfile && emergency.doctorId?.toString() === doctorProfile._id.toString();
    if (!isPatient && !isDoctor) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    // Validate status transitions
    const validTransitions = {
      pending: ['accepted', 'cancelled'],
      accepted: ['in_progress', 'cancelled'],
      in_progress: ['completed', 'cancelled'],
    };

    const allowed = validTransitions[emergency.status];
    if (!allowed || !allowed.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot transition from '${emergency.status}' to '${status}'`,
      });
    }

    emergency.status = status;
    if (status === 'completed') {
      emergency.completedAt = new Date();
    }
    await emergency.save();

    // Notify both patient and doctor of status change
    try {
      const { getIO } = require('../sockets/socket');
      const io = getIO();
      io.to(`user_${emergency.patientId.toString()}`).emit('emergency-status-updated', {
        emergencyId: emergency._id.toString(),
        status,
      });
      if (emergency.doctorId) {
        // Find the doctor's userId to emit to their socket room
        const docProfile = await Doctor.findById(emergency.doctorId);
        if (docProfile) {
          io.to(`user_${docProfile.userId.toString()}`).emit('emergency-status-updated', {
            emergencyId: emergency._id.toString(),
            status,
          });
        }
      }
    } catch (socketErr) {
      console.warn('Socket emit failed:', socketErr.message);
    }

    res.json({ success: true, emergency });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/* =========================
   GET EMERGENCY CHAT MESSAGES
   - Only patient or assigned doctor
========================= */
exports.getMessages = async (req, res) => {
  try {
    const emergency = await EmergencyRequest.findById(req.params.requestId);
    if (!emergency) {
      return res.status(404).json({
        success: false,
        message: 'Emergency request not found',
      });
    }

    // Check that emergency is accepted (chat unlocked)
    if (emergency.status === 'pending') {
      return res.status(403).json({
        success: false,
        message: 'Chat is not available until a doctor accepts the emergency',
      });
    }

    const messages = await ChatMessage.find({ emergencyId: req.params.requestId })
      .sort({ timestamp: 1 });

    res.json({ success: true, messages });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/* =========================
   SEND EMERGENCY CHAT MESSAGE
   - Only patient or assigned doctor
   - Chat must be unlocked (status != pending)
========================= */
exports.sendMessage = async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({
        success: false,
        message: 'Message is required',
      });
    }

    const emergency = await EmergencyRequest.findById(req.params.requestId);
    if (!emergency) {
      return res.status(404).json({
        success: false,
        message: 'Emergency request not found',
      });
    }

    // Chat only available after doctor accepts
    if (emergency.status === 'pending') {
      return res.status(403).json({
        success: false,
        message: 'Chat is not available until a doctor accepts the emergency',
      });
    }

    const chatMessage = await ChatMessage.create({
      emergencyId: req.params.requestId,
      senderId: req.user.id,
      senderRole: req.user.role === 'doctor' ? 'DOCTOR' : 'PATIENT',
      message,
    });

    res.status(201).json({ success: true, message: chatMessage });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
