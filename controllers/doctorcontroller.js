const Doctor = require("../models/doctor");
const User = require("../models/user");
const Appointment = require("../models/appointment");
const { calculateDistanceKm } = require("../services/geoservice");

const escapeRegExp = (value = "") => {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

const getSpecialityRegex = (specialization) => {
  if (!specialization) return null;

  const aliases = {
    "General Physician": ["General Physician", "General Medicine"],
    Orthopedic: ["Orthopedic", "Orthopedist", "Orthopedics"],
    ENT: ["ENT", "Otolaryngologist"],
  };

  const values = aliases[specialization] || [specialization];
  return new RegExp(values.map(escapeRegExp).join("|"), "i");
};

/* =========================
   CREATE DOCTOR PROFILE
========================= */
exports.createDoctorProfile = async (req, res) => {
  try {
    const doctor = await Doctor.create({
      userId: req.user.id,
      ...req.body
    });

    await User.findByIdAndUpdate(req.user.id, {
      role: "doctor",
      doctorInfo: doctor._id
    });

    res.status(201).json({
      success: true,
      message: "Doctor profile created successfully",
      doctor
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/* =========================
   GET DOCTORS (SEARCH + FILTER + GEOSPATIAL)
========================= */
exports.getDoctors = async (req, res) => {
  try {
    const {
      query,
      specialization,
      availableNow,
      acceptingEmergency,
      latitude,
      longitude,
      radius,
      city,
      sortBy = "rating",
      page = 1,
      limit = 20
    } = req.query;

    const filter = {};

    if (specialization) filter.speciality = getSpecialityRegex(specialization);

    if (availableNow)
      filter["availability.online"] = availableNow === "true";

    if (acceptingEmergency)
      filter["availability.acceptEmergency"] = acceptingEmergency === "true";

    // City-based filtering: find users in that city, then filter doctors by those user IDs
    let cityUserIds = null;
    if (city) {
      const cityUsers = await User.find({
        "address.city": new RegExp(`^${escapeRegExp(city.trim())}$`, "i"),
      }).select("_id");
      cityUserIds = cityUsers.map((u) => u._id);
    }

    // Apply city filter first (limits all results to doctors in that city)
    if (cityUserIds) {
      filter.userId = { $in: cityUserIds };
    }

    if (query?.trim()) {
      const searchRegex = new RegExp(escapeRegExp(query.trim()), "i");
      // Text search: match by speciality, clinic name, or doctor name
      const matchingUsers = await User.find({
        $or: [
          { name: searchRegex },
          { fullName: searchRegex },
          { firstName: searchRegex },
          { lastName: searchRegex },
        ],
        ...(cityUserIds ? { _id: { $in: cityUserIds } } : {}),
      }).select("_id");

      const orConditions = [
        { speciality: searchRegex },
        { "clinicInfo.name": searchRegex },
        { "clinicInfo.address": searchRegex },
      ];
      if (matchingUsers.length > 0) {
        orConditions.push({ userId: { $in: matchingUsers.map((u) => u._id) } });
      }
      filter.$or = orConditions;
    }

    // Geospatial search if location provided (and no city filter, to avoid conflicts)
    if (latitude && longitude && !city) {
      const radiusKm = Number(radius) || 10;
      filter.location = {
        $nearSphere: {
          $geometry: {
            type: "Point",
            coordinates: [Number(longitude), Number(latitude)],
          },
          $maxDistance: radiusKm * 1000, // km to meters
        },
      };
    }

    const skip = (Number(page) - 1) * Number(limit);

    const allowedSorts = {
      rating: { rating: -1, reviewCount: -1 },
      experience: { experience: -1 },
      consultationFee: { consultationFee: 1 },
    };
    const sortOption = sortBy === "distance" ? {} : (allowedSorts[sortBy] || allowedSorts.rating);

    let doctors = await Doctor.find(filter)
      .populate("userId", "name fullName firstName lastName profilePicture avatar address")
      .sort(sortOption)
      .skip(skip)
      .limit(Number(limit));

    // Calculate distance for each doctor if user location provided
    if (latitude && longitude) {
      doctors = doctors.map(doc => {
        const docObj = doc.toObject ? doc.toObject() : doc;
        const coords = docObj.location?.coordinates;
        if (coords && coords.length === 2) {
          docObj.distance = calculateDistanceKm(
            Number(latitude), Number(longitude),
            coords[1], coords[0]
          );
        }
        return docObj;
      });

      // Sort by distance if requested
      if (sortBy === "distance") {
        doctors.sort((a, b) => (a.distance || Infinity) - (b.distance || Infinity));
      }
    }

    const total = await Doctor.countDocuments(filter);

    res.json({
      success: true,
      doctors,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit))
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/* =========================
   GET DOCTOR BY ID
========================= */
exports.getDoctorById = async (req, res) => {
  const doctor = await Doctor.findById(req.params.doctorId).populate(
    "userId",
    "name fullName firstName lastName profilePicture address"
  );

  if (!doctor)
    return res.status(404).json({ success: false, message: "Doctor not found" });

  res.json({ success: true, doctor });
};

/* =========================
   DOCTOR AVAILABILITY
   - Generates 30-minute slots based on working hours
   - Excludes already booked slots
========================= */
exports.getDoctorAvailability = async (req, res) => {
  try {
    const { date } = req.query;

    if (!date)
      return res.status(400).json({ success: false, message: "Date required" });

    const doctor = await Doctor.findById(req.params.doctorId);
    if (!doctor)
      return res.status(404).json({ success: false, message: "Doctor not found" });

    // Use doctor's consulting hours or default 09:00 - 17:00 (30-min slots)
    const startHour = doctor.consultingHours?.start ?? 9;
    const endHour = doctor.consultingHours?.end ?? 17;
    const slotDuration = 30; // minutes

    // Generate all possible slots
    const allSlots = [];
    for (let h = startHour; h < endHour; h++) {
      for (let m = 0; m < 60; m += slotDuration) {
        if (h * 60 + m + slotDuration > endHour * 60) continue;
        allSlots.push(
          `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
        );
      }
    }

    // Find already booked slots for this doctor on this date
    // Parse YYYY-MM-DD safely to avoid timezone issues
    const [y, mo, d] = date.split('-').map(Number);
    const startOfDay = new Date(y, mo - 1, d, 0, 0, 0, 0);
    const endOfDay = new Date(y, mo - 1, d, 23, 59, 59, 999);

    const bookedAppointments = await Appointment.find({
      doctorId: req.params.doctorId,
      date: { $gte: startOfDay, $lte: endOfDay },
      status: { $in: ["pending", "upcoming"] },
    });

    const bookedTimes = bookedAppointments.map(a => a.time);

    // Check if queried date is today — mark past slots unavailable
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const queryDateStr = date; // Already YYYY-MM-DD from frontend
    const isToday = queryDateStr === todayStr;

    const slots = allSlots.map(time => {
      let available = !bookedTimes.includes(time);

      // If today, disable slots that have already passed
      if (isToday && available) {
        const [h, m] = time.split(':').map(Number);
        const slotTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
        if (slotTime <= now) {
          available = false;
        }
      }

      return { time, available };
    });

    res.json({
      success: true,
      date,
      doctorId: req.params.doctorId,
      slots
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/* =========================
   TOGGLE FAVORITE
========================= */
exports.toggleFavorite = async (req, res) => {
  const user = await User.findById(req.user.id);

  const doctorId = req.params.doctorId;
  const index = user.favorites.findIndex(id => id.toString() === doctorId);

  let isFavorite;

  if (index === -1) {
    user.favorites.push(doctorId);
    isFavorite = true;
  } else {
    user.favorites.splice(index, 1);
    isFavorite = false;
  }

  await user.save();

  res.json({
    success: true,
    isFavorite,
    message: isFavorite
      ? "Doctor added to favorites"
      : "Doctor removed from favorites"
  });
};

/* =========================
   GET FAVORITES
========================= */
exports.getFavorites = async (req, res) => {
  const user = await User.findById(req.user.id).populate({
    path: "favorites",
    populate: {
      path: "userId",
      select: "name fullName firstName lastName profilePicture avatar address"
    }
  });

  res.json({
    success: true,
    doctors: user.favorites
  });
};
