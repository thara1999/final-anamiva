const User = require("../models/user");
const Doctor = require("../models/doctor");
const jwt = require("jsonwebtoken");
const { sendOTP, verifyOTP } = require("../config/otp");
const { JWT_SECRET, JWT_EXPIRES_IN } = require("../config/env");

const normalizePhone = (phone = "") => {
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length > 10) return digits.slice(-10);
  return digits;
};

const getPhoneVariants = (phone = "") => {
  const normalized = normalizePhone(phone);
  return [...new Set([
    phone,
    normalized,
    `+91${normalized}`,
    `91${normalized}`,
  ].filter(Boolean))];
};

const findUserByPhone = async (phone) => {
  return User.findOne({
    phoneNumber: { $in: getPhoneVariants(phone) },
  }).sort({ isProfileCompleted: -1, updatedAt: -1 });
};

/* =====================
   SEND OTP (rate limited: max 3/hr per phone)
===================== */
exports.sendOtp = async (req, res) => {
  try {
    const rawPhone = req.body.phone;
    const phone = normalizePhone(rawPhone);

    if (!phone)
      return res.status(400).json({
        success: false,
        message: "Phone required"
      });

    const smsPhone = String(rawPhone).trim().startsWith('+') ? String(rawPhone).trim() : `+91${phone}`;
    await sendOTP(smsPhone);

    res.json({
      success: true,
      message: `OTP sent successfully to ${phone}`
    });
  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({
      success: false,
      message: err.message
    });
  }
};

/* =====================
   VERIFY OTP
===================== */
exports.verifyOtp = async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const { otp } = req.body;

  if (!phone || !otp)
    return res.status(400).json({
      success: false,
      message: "Phone & OTP required"
    });

  const valid = await verifyOTP(phone, otp);
  if (!valid)
    return res.status(400).json({
      success: false,
      message: "Invalid or expired OTP"
    });

  let user = await findUserByPhone(phone);

  // Mark phone as verified after successful OTP
  // Use updateOne to avoid full document validation (prevents failures from
  // legacy data with invalid enum values like a misspelled gender)
  if (user) {
    await User.updateOne(
      { _id: user._id },
      { $set: { phoneVerified: true } }
    );
    user.phoneVerified = true;
  }

  // EXISTING USER
  if (user && user.isProfileCompleted) {
    const token = jwt.sign(
      { id: user._id, role: user.role, phoneVerified: true },
      JWT_SECRET,
      { expiresIn: "30d" }
    );

    // If user is a doctor, merge doctor profile data
    let userData = user;
    if (user.role === 'doctor') {
      const doctorProfile = await Doctor.findOne({ userId: user._id });
      if (doctorProfile) {
        userData = {
          ...user.toObject(),
          specialization: doctorProfile.speciality,
          experience: doctorProfile.experience,
          rating: doctorProfile.rating,
          reviewCount: doctorProfile.reviewCount,
          consultationFee: doctorProfile.consultationFee,
          qualifications: doctorProfile.degree,
          registrationNumber: doctorProfile.registrationNo,
          clinicInfo: doctorProfile.clinicInfo,
          availability: doctorProfile.availability,
          languages: doctorProfile.languages,
          consultingHours: doctorProfile.consultingHours,
          doctorProfileId: doctorProfile._id,
        };
      }
    }

    return res.json({
      success: true,
      user: userData,
      isNewUser: false,
      token
    });
  }

  // NEW USER
  const tempToken = jwt.sign(
    { phone, isTemp: true },
    JWT_SECRET,
    { expiresIn: "50m" }
  );

  res.json({
    success: true,
    isNewUser: true,
    phone,
    tempToken
  });
};

/* =====================
   SELECT ROLE
===================== */
exports.selectRole = async (req, res) => {
  const { role } = req.body;
  const phone = normalizePhone(req.user.phone);

  if (!["patient", "doctor"].includes(role))
    return res.status(400).json({ message: "Invalid role" });

  const existingUser = await findUserByPhone(phone);
  if (existingUser) {
    existingUser.role = role;
    await existingUser.save({ validateBeforeSave: false });
  } else {
    await User.create({ phoneNumber: phone, role });
  }

  res.json({
    success: true,
    role,
    phone
  });
};

/* =====================
   COMPLETE PROFILE
===================== */
exports.completeProfile = async (req, res) => {
  const phone = normalizePhone(req.user.phone);

  const profileUpdates = {
    ...req.body,
    name: req.body.fullName || req.body.name || `${req.body.firstName || ''} ${req.body.lastName || ''}`.trim(),
    isProfileCompleted: true,
    phoneVerified: true
  };

  const existingUser = await findUserByPhone(phone);
  const user = existingUser
    ? await User.findByIdAndUpdate(existingUser._id, profileUpdates, { new: true })
    : await User.create({ ...profileUpdates, phoneNumber: phone });

  // Auto-create Doctor profile if role is doctor and none exists
  let doctorProfile = null;
  if (user.role === 'doctor') {
    const existingDoctor = await Doctor.findOne({ userId: user._id });
    if (!existingDoctor) {
      // Geocode city to coordinates (approximate Indian city centers)
      const cityCoords = {
        'chennai': [80.2707, 13.0827],
        'mumbai': [72.8777, 19.0760],
        'delhi': [77.1025, 28.7041],
        'bangalore': [77.5946, 12.9716],
        'bengaluru': [77.5946, 12.9716],
        'hyderabad': [78.4867, 17.3850],
        'kolkata': [88.3639, 22.5726],
        'pune': [73.8567, 18.5204],
        'trichy': [78.7047, 10.7905],
        'tiruchirappalli': [78.7047, 10.7905],
        'coimbatore': [76.9558, 11.0168],
        'madurai': [78.1198, 9.9252],
        'salem': [78.1460, 11.6643],
        'erode': [77.7172, 11.3410],
        'tirunelveli': [77.7567, 8.7139],
        'kochi': [76.2673, 9.9312],
        'ahmedabad': [72.5714, 23.0225],
        'jaipur': [75.7873, 26.9124],
        'lucknow': [80.9462, 26.8467],
        'chandigarh': [76.7794, 30.7333],
        'indore': [75.8577, 22.7196],
        'nagpur': [79.0882, 21.1458],
        'visakhapatnam': [83.2185, 17.6868],
        'bhopal': [77.4126, 23.2599],
        'patna': [85.1376, 25.6093],
      };

      const city = (req.body.city || req.body.address?.city || '').toLowerCase().trim();
      const lat = req.body.location?.latitude;
      const lng = req.body.location?.longitude;
      let coordinates = [80.2707, 13.0827]; // default Chennai

      if (lat && lng) {
        coordinates = [Number(lng), Number(lat)];
      } else if (city && cityCoords[city]) {
        coordinates = cityCoords[city];
      }

      // Map availability from frontend format to backend schema
      const avail = req.body.availability || {};
      const availability = {
        online: avail.isOnline !== undefined ? avail.isOnline : (avail.online !== undefined ? avail.online : true),
        clinicOpen: avail.clinicOpen || false,
        acceptEmergency: avail.acceptingEmergency || avail.acceptEmergency || false,
      };

      const doctorData = {
        userId: user._id,
        speciality: req.body.specialization || req.body.speciality || 'General Medicine',
        degree: req.body.qualifications || req.body.degree || 'MBBS',
        registrationNo: req.body.registrationNumber || req.body.registrationNo || 'PENDING',
        experience: parseInt(req.body.experience) || 0,
        consultationFee: parseInt(req.body.consultationFee) || 0,
        availability,
        languages: req.body.languages || ['English'],
        clinicInfo: {
          name: req.body.clinicName || req.body.address?.clinic || '',
          address: req.body.clinicAddress || req.body.address?.street || '',
        },
        consultingHours: {
          start: parseInt(req.body.consultingHours?.start, 10) || 9,
          end: parseInt(req.body.consultingHours?.end, 10) || 17,
        },
        location: {
          type: 'Point',
          coordinates,
        }
      };
      const newDoctor = await Doctor.create(doctorData);
      doctorProfile = newDoctor;
      console.log(`Auto-created Doctor profile ${newDoctor._id} for user ${user._id} in city: ${city || 'default'}`);
    } else {
      doctorProfile = existingDoctor;
    }
  }

  const token = jwt.sign(
    { id: user._id, role: user.role, phoneVerified: true },
    JWT_SECRET,
    { expiresIn: "30d" }
  );

  // Merge doctor profile fields into the response so frontend has them immediately
  let responseUser = user.toObject ? user.toObject() : { ...user };
  if (doctorProfile) {
    responseUser = {
      ...responseUser,
      specialization: doctorProfile.speciality,
      experience: doctorProfile.experience,
      rating: doctorProfile.rating,
      reviewCount: doctorProfile.reviewCount,
      consultationFee: doctorProfile.consultationFee,
      qualifications: doctorProfile.degree,
      registrationNumber: doctorProfile.registrationNo,
      clinicInfo: doctorProfile.clinicInfo,
      availability: doctorProfile.availability,
      languages: doctorProfile.languages,
      consultingHours: doctorProfile.consultingHours,
      doctorProfileId: doctorProfile._id,
    };
  }

  res.status(201).json({
    success: true,
    user: responseUser,
    token
  });
};

/* =====================
   GET ME
===================== */
exports.getMe = async (req, res) => {
  const user = await User.findById(req.user.id);

  // If user is a doctor, also fetch the doctor profile data
  if (user && user.role === 'doctor') {
    const doctorProfile = await Doctor.findOne({ userId: user._id });

    if (doctorProfile) {
      // Merge doctor profile data with user data
      const userWithDoctorProfile = {
        ...user.toObject(),
        // Map doctor fields to the names expected by the frontend
        specialization: doctorProfile.speciality,
        experience: doctorProfile.experience,
        rating: doctorProfile.rating,
        reviewCount: doctorProfile.reviewCount,
        consultationFee: doctorProfile.consultationFee,
        qualifications: doctorProfile.degree,
        registrationNumber: doctorProfile.registrationNo,
        clinicInfo: doctorProfile.clinicInfo,
        availability: doctorProfile.availability,
        languages: doctorProfile.languages,
        consultingHours: doctorProfile.consultingHours,
        // Keep doctor profile ID for reference
        doctorProfileId: doctorProfile._id,
      };

      return res.json({ success: true, user: userWithDoctorProfile });
    }
  }

  res.json({ success: true, user });
};

/* =====================
   LOGOUT
===================== */
exports.logout = async (req, res) => {
  res.json({ success: true, message: "Logged out successfully" });
};

/* =====================
   UPDATE PROFILE
===================== */
exports.updateProfile = async (req, res) => {
  try {
    console.log('[updateProfile] userId:', req.user.id, 'role:', req.user.role);
    console.log('[updateProfile] address:', JSON.stringify(req.body.address));
    console.log('[updateProfile] specialization:', req.body.specialization, 'clinicName:', req.body.address?.clinic);

    const user = await User.findByIdAndUpdate(
      req.user.id,
      req.body,
      { new: true }
    );

    console.log('[updateProfile] saved user.address:', JSON.stringify(user?.address));

    // If doctor, also update the Doctor model with professional fields
    if (user && user.role === 'doctor') {
      const doctorProfile = await Doctor.findOne({ userId: user._id });
      if (doctorProfile) {
        const doctorUpdates = {};

        if (req.body.specialization) doctorUpdates.speciality = req.body.specialization;
        if (req.body.qualifications) doctorUpdates.degree = req.body.qualifications;
        if (req.body.registrationNumber) doctorUpdates.registrationNo = req.body.registrationNumber;
        if (req.body.experience !== undefined) doctorUpdates.experience = parseInt(req.body.experience) || 0;
        if (req.body.consultationFee !== undefined) doctorUpdates.consultationFee = parseInt(req.body.consultationFee) || 0;
        if (req.body.bio !== undefined) doctorUpdates.bio = req.body.bio;
        if (req.body.consultingHours) {
          doctorUpdates.consultingHours = {
            start: parseInt(req.body.consultingHours.start) || 9,
            end: parseInt(req.body.consultingHours.end) || 17,
          };
        }

        // Update clinicInfo from address fields
        if (req.body.address) {
          doctorUpdates.clinicInfo = {
            name: req.body.address.clinic || doctorProfile.clinicInfo?.name || '',
            address: req.body.address.street || doctorProfile.clinicInfo?.address || '',
          };
        }

        if (Object.keys(doctorUpdates).length > 0) {
          await Doctor.findByIdAndUpdate(doctorProfile._id, doctorUpdates);
          console.log(`Updated Doctor profile ${doctorProfile._id} with:`, Object.keys(doctorUpdates));
        }

        // Re-fetch and merge for response
        const updatedDoctor = await Doctor.findById(doctorProfile._id);
        const mergedUser = {
          ...user.toObject(),
          specialization: updatedDoctor.speciality,
          experience: updatedDoctor.experience,
          rating: updatedDoctor.rating,
          reviewCount: updatedDoctor.reviewCount,
          consultationFee: updatedDoctor.consultationFee,
          qualifications: updatedDoctor.degree,
          registrationNumber: updatedDoctor.registrationNo,
          clinicInfo: updatedDoctor.clinicInfo,
          availability: updatedDoctor.availability,
          languages: updatedDoctor.languages,
          consultingHours: updatedDoctor.consultingHours,
          doctorProfileId: updatedDoctor._id,
        };

        return res.json({ success: true, user: mergedUser });
      }
    }

    res.json({ success: true, user });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/* =====================
   UPLOAD AVATAR
===================== */
exports.uploadAvatar = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    // Build the public URL for the uploaded file
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const avatarUrl = `${baseUrl}/uploads/${req.file.filename}`;

    // Update user's profilePicture and avatar fields
    const user = await User.findByIdAndUpdate(
      req.user.id,
      { profilePicture: avatarUrl, avatar: avatarUrl },
      { new: true }
    );

    res.json({
      success: true,
      avatarUrl,
      user,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
