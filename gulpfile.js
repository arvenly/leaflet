var gulp = require("gulp");

gulp.task('copy', function () {
  gulp.src('./dist/leaflet.draw.js')
      .pipe(gulp.dest('D:/SAAS2.0/saas-webapp/application/dist/saasweb/libs/supermap/iclient-9d-leaflet/leaflet/draw/'));
});

